// TomahawkTools — Cloudflare Worker
// Returns Manager + Stock Taking App + Scanner App + Label Generator + Blinkit Invoice
// Worker: tomahawk-returns.naimuddin.workers.dev
// D1 binding: DB → tomahawk-returns

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Tomahawk-Session',
  'Content-Type': 'application/json'
};

const GSHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6Rf-UNZQV6mN-NjbbX8YPJf-B0lEoPRWsozKmfoDTB5KpXXthHfGH_qnJDEhR_uB38gy_0n3N7fwv/pub?gid=997578035&single=true&output=csv';

// Stock Alert — UC_Inventory GAS bridge (same endpoint the frontend used to
// call directly; now proxied + edge-cached here via the sa_loadAll action).
const SA_UC_GAS_URL = 'https://script.google.com/macros/s/AKfycbwPnZl404I0IVHgIxy6QRxSCdep3XbqufE73w8ZdA1qugPEdygzoRhtht10RWT6fkjGTQ/exec';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

// ── CSV row parser (handles quoted fields with commas inside) ──
function parseCSVRow(row) {
  if (!row || !row.trim()) return null;
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ══════════════════════════════════════════════════════════════════
// AUTH — Portal-wide login, sessions, and role-based permissions
// ══════════════════════════════════════════════════════════════════
//
// Roles, in increasing order of access — each includes everything the
// one before it can do, plus more:
//   picker_packer  →  Scanner App only (phone scanning)
//   viewer         →  picker_packer's access, PLUS read-only view of
//                      Returns Manager, Stock Alert, Stock-Taking,
//                      Scanner Dashboard, and Marketplace-Shipments
//                      (Flipkart/Blinkit label + ledger tools). NOT
//                      Inward Label Generator — viewer has no access
//                      there at all, not even read.
//   manager        →  viewer's access, PLUS full edit/write on every
//                      app above, PLUS Inward Label Generator entirely,
//                      PLUS Scanner Dashboard's session lifecycle and
//                      team-roster management.
//   admin          →  everything, PLUS portal user management and the
//                      handful of "wipe everything" dev/temp actions.
//
// Every action maps to exactly one tier below. Unmapped actions fall
// back to 'manager_up' (fail-closed — safer to accidentally block a
// viewer on something new than to accidentally expose it).
//
//   'public'      — no session needed
//   'viewer_read' — admin, manager, or viewer
//   'manager_up'  — admin or manager only
//   'scanner_app' — admin, manager, or picker_packer (phone scanning)
//   'admin_only'  — admin only, ALWAYS enforced regardless of the
//                    soft-launch flag below
//
// SOFT-LAUNCH FLAG (tm_settings.enforce_auth):
//   None of the app frontends send a session token yet except the hub
//   and Scanner Dashboard, so 'viewer_read'/'manager_up'/'scanner_app'
//   tiers only actually block anyone once an admin flips
//   tm_settings.enforce_auth to '1' (via adminSetEnforcement) — which
//   should happen only after every app below has been updated to send
//   the X-Tomahawk-Session header. admin_only is exempt from this flag
//   and is always gated.
// ══════════════════════════════════════════════════════════════════

const ACTION_TIERS = {
  // — Public: no session needed —
  ping: 'public', login: 'public', logout: 'public', authStatus: 'public',
  scannerLogin: 'public', // legacy phone-app login, not yet migrated to portal auth
  scannerListPickers: 'public', // phone app's name-picker list — read-only, usernames only
  scannerPickSession: 'public', // phone app "tap your name" login — locked to picker_packer role only, see handler
  validateSession: 'viewer_read', // any authenticated role may confirm their own session

  // — Admin only: portal user management + "wipe everything" dev actions —
  adminListUsers: 'admin_only', adminCreateUser: 'admin_only', adminUpdateUser: 'admin_only',
  adminResetPassword: 'admin_only', adminDeleteUser: 'admin_only', adminSetEnforcement: 'admin_only',
  wipeAllReturns: 'admin_only', blinkitDeleteAllInvoices: 'admin_only',
  fkLedgerDeleteAll: 'admin_only', resetBoxCounters: 'admin_only', sm_migrateLegacy: 'admin_only',

  // — Returns Manager: viewer can view, strictly no edits or logs —
  load: 'viewer_read',
  saveReturn: 'manager_up', saveReturns: 'manager_up', saveFba: 'manager_up',
  setMeta: 'manager_up', setMetaBatch: 'manager_up', saveAll: 'manager_up',

  // — Stock Alert: viewer can view, no edits —
  sa_getQtyOverrides: 'viewer_read', sa_getArchivedSkus: 'viewer_read',
  sa_getRecQtyOverrides: 'viewer_read', sa_getSettings: 'viewer_read',
  sa_getG4BoxCounts: 'viewer_read',
  sa_loadAll: 'viewer_read',
  sa_saveQtyOverride: 'manager_up', sa_deleteQtyOverride: 'manager_up',
  sa_bulkImportQtyOverrides: 'manager_up', sa_archiveSku: 'manager_up',
  sa_unarchiveSku: 'manager_up', sa_saveRecQtyOverride: 'manager_up',
  sa_deleteRecQtyOverride: 'manager_up', sa_saveSettings: 'manager_up',
  sa_saveG4BoxCount: 'manager_up',

  // — Stock-Taking: not one of the 6 named apps, defaulted to match Stock Alert —
  loadStock: 'viewer_read',
  saveBox: 'manager_up', deleteBox: 'manager_up', deleteSKU: 'manager_up',
  saveLoose: 'manager_up', deleteLoose: 'manager_up',
  saveUCDisable: 'manager_up', deleteUCDisable: 'manager_up',
  saveStockSettings: 'manager_up', saveBinAllotment: 'manager_up', deleteBinAllotment: 'manager_up',

  // — Marketplace-Shipments / "Label Generator" (Flipkart labels, Blinkit,
  //   Flipkart ledger): viewer can view across all of it, no edits anywhere —
  gsheetLookup: 'viewer_read', loadLibrary: 'viewer_read',
  saveLibModel: 'manager_up', deleteLibModel: 'manager_up',
  blinkitGetInvSeq: 'viewer_read', blinkitCheckInv: 'viewer_read', blinkitListInv: 'viewer_read',
  blinkitGetInvHtml: 'viewer_read', blinkitGetInvItems: 'viewer_read', blinkitGetCnSeq: 'viewer_read',
  blinkitListCN: 'viewer_read', blinkitGetCnHtml: 'viewer_read', blinkitCheckCN: 'viewer_read',
  bk_libLoad: 'viewer_read',
  blinkitSaveInv: 'manager_up', blinkitSaveReceivedQty: 'manager_up',
  blinkitSaveCreditNote: 'manager_up', blinkitSaveStatusNote: 'manager_up',
  bk_libSave: 'manager_up', blinkitDeleteInvoiceByRO: 'manager_up',
  fkLedgerLoad: 'viewer_read', fkWarehouseMapLoad: 'viewer_read', fkLibLoad: 'viewer_read',
  fkLedgerSave: 'manager_up', fkLibSave: 'manager_up',
  fkWarehouseMapSave: 'manager_up', fkWarehouseMapDelete: 'manager_up',

  // — Blinkit RO email watcher (Gmail integration) — logging is read-only
  //   in effect, but touches D1 + calls Gmail, so gate it manager_up like
  //   every other Blinkit write. List is viewer_read to match the rest
  //   of Marketplace-Shipments' read tier. —
  blinkitCheckRoEmails: 'manager_up', blinkitListRoLog: 'viewer_read', blinkitDebugGmail: 'manager_up',

  // — Inward Label Generator (Gate Pass): admin + manager ONLY, no viewer
  //   access at all, not even read —
  getGpImages: 'manager_up', getSkuMap: 'manager_up', getBwImages: 'manager_up',
  gp_getBoxCounters: 'manager_up', gp_getSettings: 'manager_up', syncGpImages: 'manager_up',
  saveSkuMapBulk: 'manager_up', getNextBoxSeq: 'manager_up',
  saveBwImage: 'manager_up', deleteBwImage: 'manager_up', gp_saveSetting: 'manager_up',

  // — SKU Master: shared table between Inward Label Generator and Stock
  //   Alert. Read stays viewer-accessible (Stock Alert needs it); writes
  //   are manager+ regardless of which app calls them. A viewer never
  //   sees Inward Label Generator's own UI to reach this read via that
  //   route — that's enforced by the app's frontend gate, not here. —
  sm_getAll: 'viewer_read',
  sm_upsert: 'manager_up', sm_upsertBulk: 'manager_up', sm_delete: 'manager_up',

  // — UC SKU List cache: shared snapshot of enabled UC_ItemMaster SKUs,
  //   refreshed on-demand from the hub (admin-only "Refresh SKU List"
  //   button) and read by Master Sheet's Add SKU dropdown. —
  ucsku_getList: 'viewer_read', ucsku_saveList: 'admin_only',

  // — Scanner Dashboard: admin + manager full access; viewer can view;
  //   picker_packer has no access to the dashboard itself. scannerLoadData
  //   is the one exception — it's also called by the phone Scanner App to
  //   show the active session/history, so it needs picker_packer too. —
  scannerLoadData: 'any_role', scannerSessionRecords: 'viewer_read',
  scannerCreateSession: 'manager_up', scannerCloseSession: 'manager_up',
  scannerAddUser: 'manager_up', scannerDeleteUser: 'manager_up',

  // — Scanner App (phone scanning): admin, manager, or picker_packer —
  scannerSaveRecord: 'scanner_app', scannerCheckBox: 'scanner_app'
};

function getAuthRequirement(act) {
  return ACTION_TIERS[act] || 'manager_up'; // fail-closed default for anything unmapped
}

function roleAllowed(role, requirement) {
  if (!role) return false;
  if (requirement === 'admin_only')  return role === 'admin';
  if (requirement === 'manager_up')  return role === 'admin' || role === 'manager';
  if (requirement === 'viewer_read') return role === 'admin' || role === 'manager' || role === 'viewer';
  if (requirement === 'scanner_app') return role === 'admin' || role === 'manager' || role === 'picker_packer';
  if (requirement === 'any_role')    return ['admin', 'manager', 'viewer', 'picker_packer'].includes(role);
  return false;
}

async function isEnforcementOn(DB) {
  const row = await DB.prepare("SELECT value FROM tm_settings WHERE key = 'enforce_auth'").first();
  return !!row && row.value === '1';
}

async function resolveSession(request, DB) {
  let token = request.headers.get('X-Tomahawk-Session');
  if (!token) {
    const url = new URL(request.url);
    token = url.searchParams.get('session');
  }
  if (!token) return null;
  const row = await DB.prepare(`
    SELECT s.expires_at, u.id as user_id, u.username, u.role, u.display_name, u.active
    FROM tm_sessions s JOIN tm_users u ON u.id = s.user_id
    WHERE s.token = ?
  `).bind(token).first();
  if (!row) return null;
  if (!row.active) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return { id: row.user_id, username: row.username, role: row.role, display_name: row.display_name };
}

async function checkAuth(request, DB, method, act) {
  const req = getAuthRequirement(act);
  if (req === 'public') return { ok: true, user: null };

  const sessionUser = await resolveSession(request, DB);

  if (req === 'admin_only') {
    if (!sessionUser) return { ok: false, error: 'Login required', status: 401 };
    if (sessionUser.role !== 'admin') return { ok: false, error: 'Admin access required', status: 403 };
    return { ok: true, user: sessionUser };
  }

  const enforcementOn = await isEnforcementOn(DB);
  if (!enforcementOn) {
    // Soft-launch: don't block yet, but attach the user if a valid token was sent
    return { ok: true, user: sessionUser };
  }
  if (!sessionUser) return { ok: false, error: 'Login required', status: 401 };
  if (!roleAllowed(sessionUser.role, req)) return { ok: false, error: 'Insufficient permissions for this action', status: 403 };
  return { ok: true, user: sessionUser };
}

// — password hashing: salted SHA-256, stretched 1000 rounds.
// Not bcrypt (no npm/build step available in a Worker without one), but a
// reasonable bar for an internal tool with a handful of known users. —
async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function genSalt() { return randomHex(16); }
function genToken() { return randomHex(32); }
async function hashPassword(password, salt) {
  let h = salt + ':' + password;
  for (let i = 0; i < 1000; i++) h = await sha256Hex(h);
  return h;
}

async function ensureAuthTables(DB) {
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS tm_users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt          TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'viewer',
      display_name  TEXT DEFAULT '',
      active        INTEGER DEFAULT 1,
      created_at    TEXT DEFAULT (datetime('now'))
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS tm_sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      role       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS tm_settings (
      key   TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    )`)
  ]);
  const adminExists = await DB.prepare("SELECT id FROM tm_users WHERE username = 'admin'").first();
  if (!adminExists) {
    const salt = genSalt();
    const hash = await hashPassword('Tomahawk@2026', salt);
    await DB.prepare(
      `INSERT INTO tm_users (username, password_hash, salt, role, display_name) VALUES ('admin', ?, ?, 'admin', 'Admin')`
    ).bind(hash, salt).run();
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    let body = null;
    if (request.method === 'POST') {
      try { body = await request.json(); } catch (e) { body = {}; }
    }
    const act = (body && body.action) || action;

    try {
      await ensureAuthTables(env.DB);

      const authResult = await checkAuth(request, env.DB, request.method, act);
      if (!authResult.ok) {
        return json({ ok: false, error: authResult.error, authError: true }, authResult.status || 401);
      }

      // ── AUTH ROUTES ───────────────────────────────────────
      if (request.method === 'POST' && act === 'login') {
        const { username, password } = body || {};
        if (!username || !password) return json({ ok: false, error: 'Username and password required' });
        const u = await env.DB.prepare('SELECT * FROM tm_users WHERE username = ?')
          .bind(String(username).toLowerCase().trim()).first();
        if (!u || !u.active) return json({ ok: false, error: 'Invalid credentials' });
        const hash = await hashPassword(password, u.salt);
        if (hash !== u.password_hash) return json({ ok: false, error: 'Invalid credentials' });
        const token = genToken();
        const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('INSERT INTO tm_sessions (token, user_id, role, expires_at) VALUES (?, ?, ?, ?)')
          .bind(token, u.id, u.role, expires).run();
        return json({ ok: true, token, user: { username: u.username, role: u.role, display_name: u.display_name } });
      }

      if (request.method === 'POST' && act === 'logout') {
        const token = request.headers.get('X-Tomahawk-Session');
        if (token) await env.DB.prepare('DELETE FROM tm_sessions WHERE token = ?').bind(token).run();
        return json({ ok: true });
      }

      // ── Phone Scanner App — "tap your name" login, no password. ──
      // Deliberately restricted to role = 'picker_packer' only — this is a
      // shared warehouse device, so it can never be used to obtain an
      // admin or manager session no matter how it's called. Admin/manager
      // always need a real password login via the hub.
      if (request.method === 'POST' && act === 'scannerPickSession') {
        const { username } = body || {};
        if (!username) return json({ ok: false, error: 'username required' });
        const u = await env.DB.prepare(
          "SELECT * FROM tm_users WHERE username = ? AND role = 'picker_packer'"
        ).bind(String(username).toLowerCase().trim()).first();
        if (!u || !u.active) return json({ ok: false, error: 'Not set up as a Picker & Packer — ask an admin to add you in Manage Users' });
        const token = genToken();
        const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('INSERT INTO tm_sessions (token, user_id, role, expires_at) VALUES (?, ?, ?, ?)')
          .bind(token, u.id, u.role, expires).run();
        return json({ ok: true, token, user: { username: u.username, role: u.role, display_name: u.display_name } });
      }

      if (request.method === 'GET' && action === 'validateSession') {
        const sessionUser = await resolveSession(request, env.DB);
        if (!sessionUser) return json({ ok: false, error: 'Invalid or expired session' }, 401);
        return json({ ok: true, user: sessionUser });
      }

      if (request.method === 'GET' && action === 'authStatus') {
        const enforced = await isEnforcementOn(env.DB);
        return json({ ok: true, enforced });
      }

      // ── Phone Scanner App — list Picker & Packer accounts to tap-pick from ──
      if (request.method === 'GET' && action === 'scannerListPickers') {
        const rows = await env.DB.prepare(
          "SELECT username, display_name FROM tm_users WHERE role = 'picker_packer' AND active = 1 ORDER BY username ASC"
        ).all();
        return json({ ok: true, users: rows.results || [] });
      }

      // ── ADMIN — user management (always gated, see checkAuth) ────
      if (request.method === 'POST' && act === 'adminListUsers') {
        const rows = await env.DB.prepare(
          'SELECT id, username, role, display_name, active, created_at FROM tm_users ORDER BY username ASC'
        ).all();
        return json({ ok: true, users: rows.results || [] });
      }
      if (request.method === 'POST' && act === 'adminCreateUser') {
        const { username, password, role, display_name } = body;
        if (!username || !password || !role) return json({ ok: false, error: 'username, password, role required' });
        if (!['admin', 'manager', 'viewer', 'picker_packer'].includes(role)) return json({ ok: false, error: 'Invalid role' });
        const salt = genSalt();
        const hash = await hashPassword(password, salt);
        try {
          await env.DB.prepare(
            'INSERT INTO tm_users (username, password_hash, salt, role, display_name) VALUES (?, ?, ?, ?, ?)'
          ).bind(String(username).toLowerCase().trim(), hash, salt, role, display_name || '').run();
          return json({ ok: true });
        } catch (e) {
          return json({ ok: false, error: 'Username already exists' });
        }
      }
      if (request.method === 'POST' && act === 'adminUpdateUser') {
        const { id, role, display_name, active } = body;
        if (!id) return json({ ok: false, error: 'id required' });
        if (role && !['admin', 'manager', 'viewer', 'picker_packer'].includes(role)) return json({ ok: false, error: 'Invalid role' });
        await env.DB.prepare(`
          UPDATE tm_users SET
            role = COALESCE(?, role),
            display_name = COALESCE(?, display_name),
            active = COALESCE(?, active)
          WHERE id = ?
        `).bind(role || null, display_name != null ? display_name : null, active != null ? (active ? 1 : 0) : null, id).run();
        if (active === false || active === 0) {
          await env.DB.prepare('DELETE FROM tm_sessions WHERE user_id = ?').bind(id).run();
        }
        return json({ ok: true });
      }
      if (request.method === 'POST' && act === 'adminResetPassword') {
        const { id, newPassword } = body;
        if (!id || !newPassword) return json({ ok: false, error: 'id and newPassword required' });
        const salt = genSalt();
        const hash = await hashPassword(newPassword, salt);
        await env.DB.prepare('UPDATE tm_users SET password_hash = ?, salt = ? WHERE id = ?').bind(hash, salt, id).run();
        await env.DB.prepare('DELETE FROM tm_sessions WHERE user_id = ?').bind(id).run();
        return json({ ok: true });
      }
      if (request.method === 'POST' && act === 'adminDeleteUser') {
        const { id } = body;
        if (!id) return json({ ok: false, error: 'id required' });
        await env.DB.batch([
          env.DB.prepare('DELETE FROM tm_sessions WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM tm_users WHERE id = ?').bind(id)
        ]);
        return json({ ok: true });
      }
      if (request.method === 'POST' && act === 'adminSetEnforcement') {
        const { enabled } = body;
        await env.DB.prepare(`
          INSERT INTO tm_settings (key, value) VALUES ('enforce_auth', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).bind(enabled ? '1' : '0').run();
        return json({ ok: true, enforced: !!enabled });
      }

      // ── GET routes ────────────────────────────────────────
      if (request.method === 'GET') {

        // ── LABEL GENERATOR — live GSheet SKU lookup ─────────
        if (action === 'gsheetLookup') {
          const forceRefresh = url.searchParams.get('refresh') === '1';
          const cacheKey = new Request('https://cache.internal/gsheet-fk-lookup-v1');
          const cache = caches.default;

          if (forceRefresh) {
            await cache.delete(cacheKey);
          } else {
            const cached = await cache.match(cacheKey);
            if (cached) {
              const body2 = await cached.text();
              return new Response(body2, {
                headers: { ...CORS, 'X-Cache': 'HIT' }
              });
            }
          }

          const csvRes = await fetch(GSHEET_CSV_URL, { cf: { cacheTtl: 0, cacheEverything: false } });
          if (!csvRes.ok) throw new Error('GSheet fetch failed: ' + csvRes.status);
          const csvText = await csvRes.text();

          const rows = csvText.split('\n');
          const lookup = {};
          for (let i = 2; i < rows.length; i++) {
            const cols = parseCSVRow(rows[i]);
            if (!cols || cols.length < 9) continue;
            const skuId  = (cols[1]  || '').trim();
            const fnsku  = (cols[4]  || '').trim();
            const subCat = (cols[3]  || '').trim();
            const mrp    = (cols[8]  || '').trim();
            const title  = (cols[0]  || '').trim();
            const dimL   = (cols[19] || '').trim();
            const dimB   = (cols[20] || '').trim();
            const dimH   = (cols[21] || '').trim();
            if (!skuId || !fnsku) continue;
            lookup[skuId] = { f: fnsku, m: mrp, c: subCat, t: title, l: dimL, b: dimB, h: dimH };
          }

          const payload = JSON.stringify({
            ok: true,
            data: lookup,
            count: Object.keys(lookup).length,
            fetched: new Date().toISOString()
          });

          const response = new Response(payload, {
            headers: { ...CORS, 'Cache-Control': 'public, max-age=86400', 'X-Cache': 'MISS' }
          });
          await cache.put(cacheKey, response.clone());
          return response;
        }

        // ── LABEL GENERATOR — load SKU library ──────────────
        if (action === 'loadLibrary') {
          await ensureLibTable(env.DB);
          const rows = await env.DB.prepare('SELECT * FROM sku_library ORDER BY model_name ASC').all();
          return json({ ok: true, rows: rows.results || [] });
        }

        // ── RETURNS MANAGER ──────────────────────────────────
        if (action === 'load') {
          const [returns, fbaReturns, meta] = await Promise.all([
            env.DB.prepare('SELECT * FROM returns ORDER BY created_at DESC').all(),
            env.DB.prepare('SELECT * FROM fba_returns ORDER BY created_at DESC').all(),
            env.DB.prepare('SELECT * FROM meta').all()
          ]);
          const fba = (fbaReturns.results || []).map(r => {
            try { return JSON.parse(r.data); } catch { return r; }
          });
          const metaMap = {};
          (meta.results || []).forEach(r => { metaMap[r.key] = r.value; });
          let master = {};
          try {
            const chunks = parseInt(metaMap['master_chunks'] || '1');
            if (chunks === 1) {
              master = JSON.parse(metaMap['master_json'] || '{}');
            } else {
              let str = '';
              for (let i = 0; i < chunks; i++) str += (metaMap['master_json_' + i] || '');
              master = JSON.parse(str || '{}');
            }
          } catch(e) { master = {}; }
          return json({
            ok: true,
            returns: (returns.results || []).map(rowToReturn),
            fbaReturns: fba,
            master,
            meta: { uploadedAt: metaMap['uploadedAt'] || '' }
          });
        }

        if (action === 'ping') {
          return json({ ok: true, ts: new Date().toISOString() });
        }

        // ── STOCK TAKING — load all data ─────────────────────
        if (action === 'loadStock') {
          await ensureStockTables(env.DB);
          const [master, loose, ucDisable, settings, binRows] = await Promise.all([
            env.DB.prepare('SELECT * FROM stock_master ORDER BY created_at DESC').all(),
            env.DB.prepare('SELECT * FROM stock_loose ORDER BY created_at DESC').all(),
            env.DB.prepare('SELECT * FROM stock_uc_disable ORDER BY created_at DESC').all(),
            env.DB.prepare('SELECT * FROM stock_settings').all(),
            env.DB.prepare('SELECT * FROM bin_allotment').all()
          ]);
          const settingsMap = {};
          (settings.results || []).forEach(r => { settingsMap[r.key] = r.value; });
          return json({
            ok: true,
            masterList:  master.results  || [],
            looseList:   loose.results   || [],
            ucList:      ucDisable.results || [],
            binList:     binRows.results || [],
            persons:     JSON.parse(settingsMap['persons']    || '[]'),
            categories:  JSON.parse(settingsMap['categories'] || '[]')
          });
        }

        // ── SCANNER — load all data ───────────────────────────
        if (action === 'scannerLoadData') {
          await ensureScannerTables(env.DB);
          const [usersRows, pastRows] = await Promise.all([
            env.DB.prepare('SELECT id, username, role FROM scanner_users').all(),
            env.DB.prepare("SELECT * FROM scanner_sessions WHERE status = 'closed' ORDER BY id DESC").all()
          ]);
          const activeSession = await env.DB.prepare(
            "SELECT * FROM scanner_sessions WHERE status = 'active' ORDER BY id DESC LIMIT 1"
          ).first();
          let records = [];
          if (activeSession) {
            const recRows = await env.DB.prepare(
              'SELECT * FROM scanner_records WHERE session_id = ? ORDER BY scanned_at ASC'
            ).bind(activeSession.id).all();
            records = recRows.results || [];
          }
          return json({
            ok: true,
            users:        usersRows.results || [],
            activeSession: activeSession || null,
            records,
            pastSessions: pastRows.results || []
          });
        }

        // ── SCANNER — check if a box_id was already scanned this session ──
        if (action === 'scannerCheckBox') {
          await ensureScannerTables(env.DB);
          const sessionId = url.searchParams.get('session_id');
          const boxId = url.searchParams.get('box_id');
          if (!sessionId || !boxId) return json({ ok: false, error: 'session_id and box_id required' }, 400);
          const row = await env.DB.prepare(
            'SELECT scanned_by, scanned_at FROM scanner_records WHERE session_id = ? AND box_id = ? ORDER BY scanned_at DESC LIMIT 1'
          ).bind(sessionId, boxId).first();
          return json({ ok: true, exists: !!row, scanned_by: row ? row.scanned_by : null, scanned_at: row ? row.scanned_at : null });
        }

        // ── GATE PASS — get image cache from D1 ──────────────
        if (action === 'getGpImages') {
          await ensureGpTables(env.DB);
          const rows = await env.DB.prepare(
            'SELECT uc_sku, image_url FROM gp_image_cache ORDER BY uc_sku ASC'
          ).all();
          return json({ ok: true, images: rows.results || [], count: (rows.results || []).length });
        }

        // ── GATE PASS — get SKU map from D1 ──────────────────
        if (action === 'getSkuMap') {
          await ensureGpTables(env.DB);
          const rows = await env.DB.prepare(
            'SELECT * FROM sku_map ORDER BY uc_sku ASC'
          ).all();
          return json({ ok: true, map: rows.results || [] });
        }

        // ── GATE PASS — get all B&W images from D1 ───────────
        if (action === 'getBwImages') {
          await ensureGpTables(env.DB);
          const rows = await env.DB.prepare(
            'SELECT uc_sku, bw_image_url, bw_source_url FROM gp_bw_images ORDER BY uc_sku ASC'
          ).all();
          return json({ ok: true, images: rows.results || [] });
        }

        // ── SKU MASTER ─────────────────────────────────────────────────
        if (action === 'sm_getAll') {
          await ensureSkuMasterTable(env.DB);
          const rows = await env.DB.prepare('SELECT * FROM sku_master ORDER BY uc_sku ASC').all();
          return json({ ok: true, rows: rows.results || [] });
        }

        // ── UC SKU LIST CACHE — shared snapshot for Add SKU dropdown ────
        if (action === 'ucsku_getList') {
          await ensureUcSkuCacheTable(env.DB);
          const row = await env.DB.prepare("SELECT value, updated_at FROM uc_sku_cache WHERE key = 'enabled_skus'").first();
          return json({ ok: true, skus: row ? JSON.parse(row.value || '[]') : [], updatedAt: row ? row.updated_at : null });
        }

        // ── GATE PASS — box counter snapshot ──────────────────
        if (action === 'gp_getBoxCounters') {
          await ensureGpTables(env.DB);
          const rows = await env.DB.prepare('SELECT key, seq FROM box_counters').all();
          return json({ ok: true, rows: rows.results || [] });
        }

        // ── GATE PASS — app settings (key/value) ──────────────
        if (action === 'gp_getSettings') {
          await ensureGpSettingsTable(env.DB);
          const rows = await env.DB.prepare('SELECT key, value FROM gp_settings').all();
          const settings = {};
          (rows.results || []).forEach(r => { settings[r.key] = r.value; });
          return json({ ok: true, settings });
        }

        // ── BLINKIT INVOICE — get next sequence number ────────
        if (action === 'blinkitGetInvSeq') {
          await ensureBlinkitTables(env.DB);
          const row = await env.DB.prepare(
            "SELECT value FROM blinkit_meta WHERE key = 'inv_seq' LIMIT 1"
          ).first();
          const seq = row ? parseInt(row.value || '0') : 0;
          return json({ ok: true, seq });
        }

        // ── BLINKIT INVOICE — check duplicate RO ─────────────
        if (action === 'blinkitCheckInv') {
          await ensureBlinkitTables(env.DB);
          const ro = url.searchParams.get('ro');
          if (!ro) return json({ inv_number: null });
          const row = await env.DB.prepare(
            'SELECT inv_number FROM blinkit_invoices WHERE ro_number = ? LIMIT 1'
          ).bind(ro).first();
          return json({ inv_number: row ? row.inv_number : null });
        }

        // ── BLINKIT INVOICE — list all invoices for ledger ───
        if (action === 'blinkitListInv') {
          await ensureBlinkitTables(env.DB);
          const rows = await env.DB.prepare(
            'SELECT ro_number, inv_number, warehouse, inv_date, created_at, sku_count, total_qty, received_qty, received_at, status_note FROM blinkit_invoices ORDER BY id DESC'
          ).all();
          return json({ ok: true, records: rows.results || [] });
        }

        // ── BLINKIT INVOICE — get stored HTML for download ───
        if (action === 'blinkitGetInvHtml') {
          await ensureBlinkitTables(env.DB);
          const inv = url.searchParams.get('inv');
          if (!inv) return json({ error: 'missing inv' }, 400);
          const row = await env.DB.prepare(
            'SELECT inv_html FROM blinkit_invoices WHERE inv_number = ? LIMIT 1'
          ).bind(inv).first();
          return json({ inv_html: row ? (row.inv_html || '') : '' });
        }

        // ── BLINKIT INVOICE — get stored items JSON for Credit Note ──
        if (action === 'blinkitGetInvItems') {
          await ensureBlinkitTables(env.DB);
          const inv = url.searchParams.get('inv');
          if (!inv) return json({ error: 'missing inv' }, 400);
          const row = await env.DB.prepare(
            'SELECT items_json, sku_count, total_qty FROM blinkit_invoices WHERE inv_number = ? LIMIT 1'
          ).bind(inv).first();
          return json({
            items_json: row ? (row.items_json || '[]') : '[]',
            sku_count:  row ? (row.sku_count  || 0)  : 0,
            total_qty:  row ? (row.total_qty  || 0)  : 0
          });
        }

        // ── BLINKIT CREDIT NOTE — get next sequence number ────
        if (action === 'blinkitGetCnSeq') {
          await ensureBlinkitTables(env.DB);
          const row = await env.DB.prepare(
            "SELECT value FROM blinkit_meta WHERE key = 'cn_seq' LIMIT 1"
          ).first();
          const seq = row ? parseInt(row.value || '0') : 0;
          return json({ ok: true, seq });
        }

        // ── BLINKIT CREDIT NOTE — list all (for ledger badges) ─
        if (action === 'blinkitListCN') {
          await ensureBlinkitTables(env.DB);
          const rows = await env.DB.prepare(
            'SELECT cn_number, inv_number, ro_number, reason, total_qty, amount, created_at FROM blinkit_credit_notes ORDER BY id DESC'
          ).all();
          return json({ ok: true, records: rows.results || [] });
        }

        // ── BLINKIT CREDIT NOTE — get stored HTML for download ─
        if (action === 'blinkitGetCnHtml') {
          await ensureBlinkitTables(env.DB);
          const cn = url.searchParams.get('cn');
          if (!cn) return json({ error: 'missing cn' }, 400);
          const row = await env.DB.prepare(
            'SELECT cn_html FROM blinkit_credit_notes WHERE cn_number = ? LIMIT 1'
          ).bind(cn).first();
          return json({ cn_html: row ? (row.cn_html || '') : '' });
        }

        // ── BLINKIT CREDIT NOTE — live check ─────────────────
        if (action === 'blinkitCheckCN') {
          await ensureBlinkitTables(env.DB);
          const inv = url.searchParams.get('inv');
          if (!inv) return json({ cn_number: null });
          const row = await env.DB.prepare(
            'SELECT cn_number FROM blinkit_credit_notes WHERE inv_number = ? LIMIT 1'
          ).bind(inv).first();
          return json({ cn_number: row ? row.cn_number : null });
        }

        // ── BLINKIT SKU LIBRARY — load ────────────────────────
        if (action === 'bk_libLoad') {
          await ensureBlinkitTables(env.DB);
          const row = await env.DB.prepare(
            "SELECT value FROM blinkit_meta WHERE key = 'sku_lib' LIMIT 1"
          ).first();
          return json({ ok: true, data: row ? (row.value || '{}') : '{}' });
        }

        // ── FLIPKART LABEL GENERATOR — load consignment ledger ────
        if (action === 'fkLedgerLoad') {
          await ensureFkLedgerTable(env.DB);
          const rows = await env.DB.prepare('SELECT * FROM fk_ledger ORDER BY created_at DESC').all();
          return json({ ok: true, rows: rows.results || [] });
        }

        // ── FLIPKART LABEL GENERATOR — load pincode → warehouse name map ────
        if (action === 'fkWarehouseMapLoad') {
          await ensureFkWarehouseMapTable(env.DB);
          const rows = await env.DB.prepare('SELECT pincode, warehouse_name FROM fk_warehouse_map').all();
          const map = {};
          (rows.results || []).forEach(r => { map[r.pincode] = r.warehouse_name; });
          return json({ ok: true, map });
        }

        // ── FLIPKART LABEL GENERATOR — load SKU library ───────
        if (action === 'fkLibLoad') {
          await ensureFkMetaTable(env.DB);
          const row = await env.DB.prepare(
            "SELECT value FROM fk_meta WHERE key = 'sku_lib' LIMIT 1"
          ).first();
          return json({ ok: true, data: row ? (row.value || '{}') : '{}' });
        }

        // ── STOCK ALERT — get all manual Qty/box overrides ────
        if (action === 'sa_getQtyOverrides') {
          await ensureSaTables(env.DB);
          const rows = await env.DB.prepare(
            'SELECT sku_code, name, qty_per_box, confirmed, updated_at FROM sa_qty_overrides ORDER BY sku_code ASC'
          ).all();
          return json({ ok: true, rows: rows.results || [] });
        }

        // ── STOCK ALERT — get all manually archived SKUs ──────
        if (action === 'sa_getArchivedSkus') {
          await ensureSaTables(env.DB);
          const rows = await env.DB.prepare(
            'SELECT sku_code, archived_at FROM sa_archived_skus ORDER BY archived_at DESC'
          ).all();
          return json({ ok: true, rows: rows.results || [] });
        }

        // ── STOCK ALERT — get all manual Rec. Qty overrides ───
        if (action === 'sa_getRecQtyOverrides') {
          await ensureSaTables(env.DB);
          const rows = await env.DB.prepare(
            'SELECT sku_code, rec_qty, updated_at FROM sa_recqty_overrides ORDER BY sku_code ASC'
          ).all();
          return json({ ok: true, rows: rows.results || [] });
        }

        // ── STOCK ALERT — get app-wide settings (key/value) ───
        if (action === 'sa_getSettings') {
          await ensureSaTables(env.DB);
          const rows = await env.DB.prepare('SELECT key, value FROM sa_settings').all();
          const settings = {};
          (rows.results || []).forEach(r => { settings[r.key] = r.value; });
          return json({ ok: true, settings });
        }

        // ── STOCK ALERT — get all manual G4 Total Box counts ──
        if (action === 'sa_getG4BoxCounts') {
          await ensureSaTables(env.DB);
          const rows = await env.DB.prepare(
            'SELECT sku_code, total_box, updated_at FROM sa_g4_box_counts ORDER BY sku_code ASC'
          ).all();
          return json({ ok: true, rows: rows.results || [] });
        }

        // ── STOCK ALERT — combined load: UC_Inventory + bundles (both
        // edge-cached) + all D1 metadata in ONE round trip. Replaces the
        // 6 separate client-side fetches (2 to Apps Script, 4 to this
        // Worker) with a single request. The GAS calls are the slow part
        // (Apps Script cold starts + full-sheet reads on every hit, no
        // caching at all) — caching them here for 5 min, well inside the
        // ~2h UC sync cadence, means repeat loads across the whole team
        // hit Cloudflare's edge cache instead of Apps Script almost every
        // time. ──
        if (action === 'sa_loadAll') {
          await ensureSaTables(env.DB);
          const cache = caches.default;

          async function cachedGasFetch(gasUrl, cacheKeyUrl) {
            const cacheKey = new Request(cacheKeyUrl);
            const cached = await cache.match(cacheKey);
            if (cached) return cached.json();
            const res = await fetch(gasUrl);
            if (!res.ok) throw new Error('GAS fetch failed: ' + res.status);
            const text = await res.text();
            const response = new Response(text, {
              headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
            });
            await cache.put(cacheKey, response.clone());
            return JSON.parse(text);
          }

          const [inventory, bundles, overridesRows, archivedRows, recQtyRows, settingsRows, g4BoxRows] = await Promise.all([
            cachedGasFetch(SA_UC_GAS_URL, 'https://cache.internal/sa-uc-inventory-v1')
              .catch(e => ({ error: e.message })),
            cachedGasFetch(SA_UC_GAS_URL + '?type=bundles', 'https://cache.internal/sa-uc-bundles-v1')
              .catch(e => ({ error: e.message })),
            env.DB.prepare('SELECT sku_code, name, qty_per_box, confirmed, updated_at FROM sa_qty_overrides ORDER BY sku_code ASC').all(),
            env.DB.prepare('SELECT sku_code, archived_at FROM sa_archived_skus ORDER BY archived_at DESC').all(),
            env.DB.prepare('SELECT sku_code, rec_qty, updated_at FROM sa_recqty_overrides ORDER BY sku_code ASC').all(),
            env.DB.prepare('SELECT key, value FROM sa_settings').all(),
            env.DB.prepare('SELECT sku_code, total_box, updated_at FROM sa_g4_box_counts ORDER BY sku_code ASC').all()
          ]);

          const settings = {};
          (settingsRows.results || []).forEach(r => { settings[r.key] = r.value; });

          return json({
            ok: true,
            inventory,
            bundles,
            overrides: overridesRows.results || [],
            archived: archivedRows.results || [],
            recQty: recQtyRows.results || [],
            settings,
            g4BoxCounts: g4BoxRows.results || []
          });
        }

        // ── BLINKIT RO EMAIL WATCHER — [TEMP DEBUG] diagnose Gmail search ──
        // Not meant to stay long-term — returns which mailbox is actually
        // authenticated plus separate counts for the label alone vs the
        // label+phrase combo, to isolate exactly where a 0-result search
        // is going wrong.
        if (action === 'blinkitDebugGmail') {
          try {
            const accessToken = await getGmailAccessToken(env);
            const authHeader = { headers: { Authorization: 'Bearer ' + accessToken } };

            const profileRes = await fetch(`${GMAIL_API_BASE}/profile`, authHeader);
            const profile = profileRes.ok ? await profileRes.json() : { error: 'profile fetch failed: ' + profileRes.status };

            const labelOnlyRes = await fetch(
              `${GMAIL_API_BASE}/messages?q=${encodeURIComponent('label:Blinkit')}&maxResults=25`, authHeader
            );
            const labelOnlyData = labelOnlyRes.ok ? await labelOnlyRes.json() : { error: 'label search failed: ' + labelOnlyRes.status };

            const phraseRes = await fetch(
              `${GMAIL_API_BASE}/messages?q=${encodeURIComponent('label:Blinkit "R.O. Number"')}&maxResults=25`, authHeader
            );
            const phraseData = phraseRes.ok ? await phraseRes.json() : { error: 'phrase search failed: ' + phraseRes.status };

            const labelsRes = await fetch(`${GMAIL_API_BASE}/labels`, authHeader);
            const labelsData = labelsRes.ok ? await labelsRes.json() : { error: 'labels fetch failed: ' + labelsRes.status };
            const blinkitLabels = (labelsData.labels || []).filter(l => /blinkit/i.test(l.name));

            return json({
              ok: true,
              authenticatedAs: profile.emailAddress || profile,
              labelOnlyCount: labelOnlyData.resultSizeEstimate != null ? labelOnlyData.resultSizeEstimate : labelOnlyData,
              phraseSearchCount: phraseData.resultSizeEstimate != null ? phraseData.resultSizeEstimate : phraseData,
              matchingLabels: blinkitLabels
            });
          } catch (err) {
            return json({ ok: false, error: err.message }, 500);
          }
        }

        // ── BLINKIT RO EMAIL WATCHER — manually trigger a Gmail check ────
        // Same logic the scheduled() cron handler runs automatically every
        // 15 min; exposed here too so it can be tested/triggered on demand
        // without waiting for the next cron tick.
        if (action === 'blinkitCheckRoEmails') {
          try {
            const result = await checkNewRoEmails(env);
            return json({ ok: true, ...result });
          } catch (err) {
            return json({ ok: false, error: err.message }, 500);
          }
        }

        // ── BLINKIT RO EMAIL WATCHER — list what's been detected so far ──
        if (action === 'blinkitListRoLog') {
          await ensureBlinkitRoTable(env.DB);
          const rows = await env.DB.prepare(
            'SELECT * FROM blinkit_ro_log ORDER BY detected_at DESC LIMIT 200'
          ).all();
          return json({ ok: true, rows: rows.results || [] });
        }

        return json({ ok: false, error: 'Unknown action' }, 400);
      }

      // ── POST routes ───────────────────────────────────────
      if (request.method === 'POST') {

        // ── RETURNS MANAGER ──────────────────────────────────
        if (act === 'saveReturn') {
          await upsertReturn(env.DB, body.return);
          return json({ ok: true });
        }
        if (act === 'saveReturns') {
          const rows = body.returns || [];
          const BATCH = 20;
          for (let i = 0; i < rows.length; i += BATCH) {
            await Promise.all(rows.slice(i, i + BATCH).map(r => upsertReturn(env.DB, r)));
          }
          return json({ ok: true, count: rows.length });
        }
        if (act === 'saveFba') {
          const rows = body.fbaReturns || [];
          await Promise.all(rows.map(r => upsertFba(env.DB, r)));
          return json({ ok: true, count: rows.length });
        }
        if (act === 'setMeta') {
          const { key, value } = body;
          await env.DB.prepare(
            'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
          ).bind(key, String(value)).run();
          return json({ ok: true });
        }
        if (act === 'setMetaBatch') {
          const pairs = body.pairs || [];
          await Promise.all(pairs.map(({ key, value }) =>
            env.DB.prepare(
              'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
            ).bind(key, String(value)).run()
          ));
          return json({ ok: true });
        }
        if (act === 'saveAll') {
          const { returns, fbaReturns, masterPairs } = body;
          const BATCH = 20;
          for (let i = 0; i < (returns||[]).length; i += BATCH) {
            await Promise.all(returns.slice(i, i+BATCH).map(r => upsertReturn(env.DB, r)));
          }
          await Promise.all((fbaReturns||[]).map(r => upsertFba(env.DB, r)));
          await Promise.all((masterPairs||[]).map(({ key, value }) =>
            env.DB.prepare(
              'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
            ).bind(key, String(value)).run()
          ));
          return json({ ok: true });
        }

        // ── RETURNS MANAGER — [TEMP] wipe ALL return logs ────
        if (act === 'wipeAllReturns') {
          await env.DB.batch([
            env.DB.prepare('DELETE FROM returns'),
            env.DB.prepare('DELETE FROM fba_returns')
          ]);
          return json({ ok: true });
        }

        // ── STOCK TAKING ──────────────────────────────────────
        if (act === 'saveBox') {
          await ensureStockTables(env.DB);
          const b = body.box;
          await env.DB.prepare(`
            INSERT INTO stock_master (id, sku, name, qty, box_num, counted_by, date, notes, saved, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              sku=excluded.sku, name=excluded.name, qty=excluded.qty,
              box_num=excluded.box_num, counted_by=excluded.counted_by,
              date=excluded.date, notes=excluded.notes, saved=1,
              updated_at=datetime('now')
          `).bind(
            String(b.id), b.sku, b.name, b.qty,
            b.boxNum || 1, b.countedBy || '', b.date || '', b.notes || ''
          ).run();
          return json({ ok: true });
        }
        if (act === 'deleteBox') {
          await env.DB.prepare('DELETE FROM stock_master WHERE id = ?').bind(String(body.id)).run();
          return json({ ok: true });
        }
        if (act === 'deleteSKU') {
          await env.DB.prepare('DELETE FROM stock_master WHERE LOWER(sku) = LOWER(?)').bind(body.sku).run();
          return json({ ok: true });
        }
        if (act === 'saveLoose') {
          await ensureStockTables(env.DB);
          const l = body.loose;
          await env.DB.prepare(`
            INSERT INTO stock_loose (id, sku, name, qty, location, date, created_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(sku) DO UPDATE SET
              qty=excluded.qty, location=excluded.location,
              date=excluded.date, updated_at=datetime('now')
          `).bind(String(l.id), l.sku, l.name || '', l.qty, l.location || '', l.date || '').run();
          return json({ ok: true });
        }
        if (act === 'deleteLoose') {
          await env.DB.prepare('DELETE FROM stock_loose WHERE id = ?').bind(String(body.id)).run();
          return json({ ok: true });
        }
        if (act === 'saveUCDisable') {
          await ensureStockTables(env.DB);
          const u = body.entry;
          await env.DB.prepare(`
            INSERT INTO stock_uc_disable (id, sku, note, date, created_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(id) DO NOTHING
          `).bind(String(u.id), u.sku, u.note || '', u.date || '').run();
          return json({ ok: true });
        }
        if (act === 'deleteUCDisable') {
          await env.DB.prepare('DELETE FROM stock_uc_disable WHERE id = ?').bind(String(body.id)).run();
          return json({ ok: true });
        }
        if (act === 'saveStockSettings') {
          await ensureStockTables(env.DB);
          const { persons, categories } = body;
          await Promise.all([
            env.DB.prepare(`INSERT INTO stock_settings (key, value, updated_at) VALUES ('persons', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(JSON.stringify(persons || [])).run(),
            env.DB.prepare(`INSERT INTO stock_settings (key, value, updated_at) VALUES ('categories', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(JSON.stringify(categories || [])).run()
          ]);
          return json({ ok: true });
        }
        if (act === 'saveBinAllotment') {
          await ensureStockTables(env.DB);
          await env.DB.prepare('INSERT OR REPLACE INTO bin_allotment (sku, bin) VALUES (?, ?)').bind(body.sku, body.bin).run();
          return json({ ok: true });
        }
        if (act === 'deleteBinAllotment') {
          await env.DB.prepare('DELETE FROM bin_allotment WHERE sku = ?').bind(body.sku).run();
          return json({ ok: true });
        }

        // ── SCANNER ───────────────────────────────────────────
        if (act === 'scannerLogin') {
          await ensureScannerTables(env.DB);
          const { username, password } = body;
          const user = await env.DB.prepare(
            'SELECT id, username, role FROM scanner_users WHERE username = ? AND password = ?'
          ).bind(username.toLowerCase().trim(), password).first();
          if (!user) return json({ ok: false, error: 'Invalid credentials' });
          return json({ ok: true, user });
        }
        if (act === 'scannerCreateSession') {
          await ensureScannerTables(env.DB);
          const { name, created_by } = body;
          await env.DB.prepare("UPDATE scanner_sessions SET status = 'closed', closed_at = datetime('now') WHERE status = 'active'").run();
          const result = await env.DB.prepare('INSERT INTO scanner_sessions (name, created_by) VALUES (?, ?)').bind(name, created_by).run();
          const session = await env.DB.prepare('SELECT * FROM scanner_sessions WHERE id = ?').bind(result.meta.last_row_id).first();
          return json({ ok: true, session });
        }
        if (act === 'scannerCloseSession') {
          await env.DB.prepare("UPDATE scanner_sessions SET status = 'closed', closed_at = datetime('now') WHERE id = ?").bind(body.session_id).run();
          return json({ ok: true });
        }
        if (act === 'scannerSaveRecord') {
          await ensureScannerTables(env.DB);
          const { record } = body;
          const result = await env.DB.prepare(
            'INSERT INTO scanner_records (session_id, sku, qty, type, scanned_by, scanned_at, box_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(record.session_id, record.sku, record.qty, record.type, record.scanned_by, record.scanned_at, record.box_id || '').run();
          return json({ ok: true, id: result.meta.last_row_id });
        }
        if (act === 'scannerSessionRecords') {
          const { session_id } = body;
          const rows = await env.DB.prepare('SELECT * FROM scanner_records WHERE session_id = ? ORDER BY scanned_at ASC').bind(session_id).all();
          return json({ ok: true, records: rows.results || [] });
        }
        if (act === 'scannerAddUser') {
          await ensureScannerTables(env.DB);
          const { username, password, role } = body;
          try {
            const result = await env.DB.prepare('INSERT INTO scanner_users (username, password, role) VALUES (?, ?, ?)').bind(username.toLowerCase().trim(), password, role).run();
            return json({ ok: true, id: result.meta.last_row_id });
          } catch(e) {
            return json({ ok: false, error: 'Username already exists' });
          }
        }
        if (act === 'scannerDeleteUser') {
          await env.DB.prepare('DELETE FROM scanner_users WHERE id = ?').bind(body.id).run();
          return json({ ok: true });
        }

        // ── LABEL GENERATOR — save/delete library model ──────
        if (act === 'saveLibModel') {
          await ensureLibTable(env.DB);
          const { model_name, category, mrp, brand, sales, dims, mfgdate, fk_skus_json } = body;
          await env.DB.prepare(`
            INSERT INTO sku_library (model_name, category, mrp, brand, sales, dims, mfgdate, fk_skus_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(model_name) DO UPDATE SET
              category=excluded.category, mrp=excluded.mrp, brand=excluded.brand,
              sales=excluded.sales, dims=excluded.dims, mfgdate=excluded.mfgdate,
              fk_skus_json=excluded.fk_skus_json, updated_at=excluded.updated_at
          `).bind(model_name, category||'', mrp||'', brand||'tomahawk', sales||'', dims||'', mfgdate||'', fk_skus_json||'[]').run();
          return json({ ok: true });
        }
        if (act === 'deleteLibModel') {
          await env.DB.prepare('DELETE FROM sku_library WHERE model_name = ?').bind(body.model_name).run();
          return json({ ok: true });
        }

        // ── GATE PASS — sync image CSV to D1 ─────────────────
        if (act === 'syncGpImages') {
          await ensureGpTables(env.DB);
          const { raw } = body;
          if (!raw || !raw.trim()) return json({ ok: false, error: 'No file content provided' });

          const lines = raw.split(/\r?\n/).filter(l => l.trim());
          if (lines.length < 2) return json({ ok: false, error: 'File has no data rows' });

          const sep = lines[0].includes('\t') ? '\t' : ',';
          const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());

          const skuIdx = headers.indexOf('skucode');
          const imgIdx = headers.indexOf('imageurl');
          if (skuIdx === -1 || imgIdx === -1) {
            return json({ ok: false, error: `Columns not found. Need: skuCode, imageUrl. Got: ${headers.join(', ')}` });
          }

          const map = {};
          let skipped_blank = 0, skipped_dupe = 0;
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
            const sku = (cols[skuIdx] || '').trim();
            const img = (cols[imgIdx] || '').trim();
            if (!sku) continue;
            if (!img) { skipped_blank++; continue; }
            if (map[sku]) skipped_dupe++;
            map[sku] = img;
          }

          const entries = Object.entries(map);
          if (!entries.length) return json({ ok: false, error: 'No rows had both skuCode and imageUrl filled in' });

          const BATCH = 20;
          for (let i = 0; i < entries.length; i += BATCH) {
            await Promise.all(entries.slice(i, i + BATCH).map(([sku, img]) =>
              env.DB.prepare(`
                INSERT INTO gp_image_cache (uc_sku, image_url, updated_at)
                VALUES (?, ?, datetime('now'))
                ON CONFLICT(uc_sku) DO UPDATE SET
                  image_url  = excluded.image_url,
                  updated_at = excluded.updated_at
              `).bind(sku, img).run()
            ));
          }

          const images = entries.map(([uc_sku, image_url]) => ({ uc_sku, image_url }));
          return json({ ok: true, synced: entries.length, skipped_blank, skipped_dupe, images });
        }

        // ── GATE PASS — save SKU map bulk ─────────────────────
        if (act === 'saveSkuMapBulk') {
          await ensureGpTables(env.DB);
          const map = body.map || [];
          const BATCH = 20;
          for (let i = 0; i < map.length; i += BATCH) {
            await Promise.all(map.slice(i, i + BATCH).map(m =>
              env.DB.prepare(`
                INSERT INTO sku_map (uc_sku, internal_sku, pcs_per_carton, image_url, category, source)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(uc_sku) DO UPDATE SET
                  internal_sku = excluded.internal_sku,
                  pcs_per_carton = excluded.pcs_per_carton,
                  image_url = excluded.image_url,
                  category = excluded.category,
                  source = excluded.source
              `).bind(
                m.ucSku, m.internalSku || '', m.pcsPerCarton || null,
                m.imageUrl || '', m.category || '', m.source || 'inline'
              ).run()
            ));
          }
          return json({ ok: true, count: map.length });
        }

        // ── GATE PASS — reset all box counters [TEMP] ────────
        if (act === 'resetBoxCounters') {
          await ensureGpTables(env.DB);
          await env.DB.prepare('DELETE FROM box_counters').run();
          return json({ ok: true });
        }
        if (act === 'getNextBoxSeq') {
          await ensureGpTables(env.DB);
          const { key } = body;
          await env.DB.prepare(`
            INSERT INTO box_counters (key, seq) VALUES (?, 1)
            ON CONFLICT(key) DO UPDATE SET seq = seq + 1
          `).bind(key).run();
          const row = await env.DB.prepare('SELECT seq FROM box_counters WHERE key = ?').bind(key).first();
          return json({ ok: true, seq: row?.seq || 1 });
        }

        // ── GATE PASS — save one B&W image to D1 ─────────────
        if (act === 'saveBwImage') {
          await ensureGpTables(env.DB);
          const { ucSku, bwImageUrl, bwSourceUrl } = body;
          if (!ucSku || !bwImageUrl) return json({ ok: false, error: 'ucSku and bwImageUrl required' }, 400);
          await env.DB.prepare(`
            INSERT INTO gp_bw_images (uc_sku, bw_image_url, bw_source_url, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(uc_sku) DO UPDATE SET
              bw_image_url  = excluded.bw_image_url,
              bw_source_url = excluded.bw_source_url,
              updated_at    = excluded.updated_at
          `).bind(ucSku, bwImageUrl, bwSourceUrl || '').run();
          return json({ ok: true });
        }

        // ── GATE PASS — delete one B&W image from D1 ─────────
        if (act === 'deleteBwImage') {
          await ensureGpTables(env.DB);
          const { ucSku } = body;
          if (!ucSku) return json({ ok: false, error: 'ucSku required' }, 400);
          await env.DB.prepare('DELETE FROM gp_bw_images WHERE uc_sku = ?').bind(ucSku).run();
          return json({ ok: true });
        }

        // ── SKU MASTER — upsert one row ───────────────────────
        if (act === 'sm_upsert') {
          await ensureSkuMasterTable(env.DB);
          await upsertSkuMaster(env.DB, body.row || body);
          return json({ ok: true });
        }

        // ── SKU MASTER — upsert many rows at once ─────────────
        if (act === 'sm_upsertBulk') {
          await ensureSkuMasterTable(env.DB);
          const rows = body.rows || [];
          const BATCH = 20;
          for (let i = 0; i < rows.length; i += BATCH) {
            await Promise.all(rows.slice(i, i + BATCH).map(r => upsertSkuMaster(env.DB, r)));
          }
          return json({ ok: true, count: rows.length });
        }

        // ── SKU MASTER — delete one row ───────────────────────
        if (act === 'sm_delete') {
          await ensureSkuMasterTable(env.DB);
          const { ucSku } = body;
          if (!ucSku) return json({ ok: false, error: 'ucSku required' }, 400);
          await env.DB.prepare('DELETE FROM sku_master WHERE uc_sku = ?').bind(ucSku).run();
          return json({ ok: true });
        }

        // ── SKU MASTER — [ONE-TIME] migrate legacy tables ─────
        if (act === 'sm_migrateLegacy') {
          await ensureSkuMasterTable(env.DB);
          await ensureGpTables(env.DB);
          const [mapRows, imgRows, bwRows] = await Promise.all([
            env.DB.prepare('SELECT * FROM sku_map').all(),
            env.DB.prepare('SELECT * FROM gp_image_cache').all(),
            env.DB.prepare('SELECT * FROM gp_bw_images').all()
          ]);
          const merged = {};
          (mapRows.results || []).forEach(r => {
            merged[r.uc_sku] = {
              ucSku: r.uc_sku, internalSku: r.internal_sku || '', category: r.category || '',
              qtyPerBox: r.pcs_per_carton || null, imageUrl: r.image_url || ''
            };
          });
          (imgRows.results || []).forEach(r => {
            if (!merged[r.uc_sku]) merged[r.uc_sku] = { ucSku: r.uc_sku };
            if (!merged[r.uc_sku].imageUrl) merged[r.uc_sku].imageUrl = r.image_url || '';
          });
          (bwRows.results || []).forEach(r => {
            if (!merged[r.uc_sku]) merged[r.uc_sku] = { ucSku: r.uc_sku };
            merged[r.uc_sku].bwImageUrl = r.bw_image_url || '';
            merged[r.uc_sku].bwSourceUrl = r.bw_source_url || '';
          });
          const entries = Object.values(merged);
          const BATCH = 20;
          for (let i = 0; i < entries.length; i += BATCH) {
            await Promise.all(entries.slice(i, i + BATCH).map(r => upsertSkuMaster(env.DB, Object.assign({ updatedBy: 'migration' }, r))));
          }
          return json({ ok: true, migrated: entries.length });
        }

        // ── GATE PASS — save one app setting ──────────────────
        if (act === 'gp_saveSetting') {
          await ensureGpSettingsTable(env.DB);
          const { key, value } = body;
          if (!key) return json({ ok: false, error: 'key required' }, 400);
          await env.DB.prepare(`
            INSERT INTO gp_settings (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          `).bind(key, value == null ? '' : String(value)).run();
          return json({ ok: true });
        }

        // ── UC SKU LIST CACHE — save freshly-fetched snapshot (admin only) ──
        if (act === 'ucsku_saveList') {
          await ensureUcSkuCacheTable(env.DB);
          const { skus } = body;
          if (!Array.isArray(skus)) return json({ ok: false, error: 'skus array required' }, 400);
          await env.DB.prepare(`
            INSERT INTO uc_sku_cache (key, value, updated_at) VALUES ('enabled_skus', ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          `).bind(JSON.stringify(skus)).run();
          return json({ ok: true, count: skus.length });
        }

        // ── BLINKIT INVOICE — save invoice record + HTML ──────
        if (act === 'blinkitSaveInv') {
          await ensureBlinkitTables(env.DB);
          const { ro_number, inv_number, seq, warehouse, inv_date, inv_html, sku_count, total_qty, items_json } = body;
          await env.DB.prepare(`
            INSERT INTO blinkit_invoices (ro_number, inv_number, seq, warehouse, inv_date, inv_html, sku_count, total_qty, items_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(ro_number) DO UPDATE SET
              inv_number = excluded.inv_number,
              seq        = excluded.seq,
              warehouse  = excluded.warehouse,
              inv_date   = excluded.inv_date,
              inv_html   = excluded.inv_html,
              sku_count  = excluded.sku_count,
              total_qty  = excluded.total_qty,
              items_json = excluded.items_json,
              created_at = datetime('now')
          `).bind(
            ro_number, inv_number, seq || 1,
            warehouse || '', inv_date || '', inv_html || '',
            sku_count || 0, total_qty || 0, items_json || '[]'
          ).run();
          await env.DB.prepare(`
            INSERT INTO blinkit_meta (key, value) VALUES ('inv_seq', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).bind(String(seq || 1)).run();
          return json({ ok: true });
        }

        // ── BLINKIT INVOICE — save/update received qty ────────
        if (act === 'blinkitSaveReceivedQty') {
          await ensureBlinkitTables(env.DB);
          const { inv_number, received_qty } = body;
          if (!inv_number) return json({ ok: false, error: 'inv_number required' }, 400);
          await env.DB.prepare(`
            UPDATE blinkit_invoices
            SET received_qty = ?, received_at = datetime('now')
            WHERE inv_number = ?
          `).bind(received_qty === '' || received_qty == null ? null : received_qty, inv_number).run();
          return json({ ok: true });
        }

        // ── BLINKIT CREDIT NOTE — save record + HTML ──────────
        if (act === 'blinkitSaveCreditNote') {
          await ensureBlinkitTables(env.DB);
          const { cn_number, inv_number, ro_number, reason, items_json, total_qty, amount, cn_html, sent_qty } = body;
          if (!cn_number || !inv_number) return json({ ok: false, error: 'cn_number and inv_number required' }, 400);
          await env.DB.prepare(`
            INSERT INTO blinkit_credit_notes (cn_number, inv_number, ro_number, reason, items_json, total_qty, amount, cn_html, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(cn_number) DO UPDATE SET
              inv_number = excluded.inv_number,
              ro_number  = excluded.ro_number,
              reason     = excluded.reason,
              items_json = excluded.items_json,
              total_qty  = excluded.total_qty,
              amount     = excluded.amount,
              cn_html    = excluded.cn_html,
              created_at = datetime('now')
          `).bind(
            cn_number, inv_number, ro_number || '', reason || '',
            items_json || '[]', total_qty || 0, amount || 0, cn_html || ''
          ).run();
          if (sent_qty && (total_qty || 0) >= sent_qty) {
            await env.DB.prepare(`
              UPDATE blinkit_invoices SET received_qty = 0, received_at = datetime('now') WHERE inv_number = ?
            `).bind(inv_number).run();
          }
          return json({ ok: true });
        }

        // ── BLINKIT INVOICE — save RO status remark ───────────
        if (act === 'blinkitSaveStatusNote') {
          await ensureBlinkitTables(env.DB);
          const { inv_number, status_note } = body;
          if (!inv_number) return json({ ok: false, error: 'inv_number required' }, 400);
          await env.DB.prepare(`
            UPDATE blinkit_invoices SET status_note = ? WHERE inv_number = ?
          `).bind(status_note || '', inv_number).run();
          return json({ ok: true });
        }

        // ── BLINKIT SKU LIBRARY — save ────────────────────────
        if (act === 'bk_libSave') {
          await ensureBlinkitTables(env.DB);
          const { data } = body;
          if (typeof data !== 'string') return json({ ok: false, error: 'data must be a JSON string' }, 400);
          await env.DB.prepare(`
            INSERT INTO blinkit_meta (key, value) VALUES ('sku_lib', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).bind(data).run();
          return json({ ok: true });
        }

        // ── BLINKIT INVOICE — [TEMP] delete ALL invoices + credit notes ───
        if (act === 'blinkitDeleteAllInvoices') {
          await ensureBlinkitTables(env.DB);
          await env.DB.batch([
            env.DB.prepare('DELETE FROM blinkit_invoices'),
            env.DB.prepare('DELETE FROM blinkit_credit_notes'),
            env.DB.prepare(`INSERT INTO blinkit_meta (key, value) VALUES ('inv_seq', '0') ON CONFLICT(key) DO UPDATE SET value='0'`),
            env.DB.prepare(`INSERT INTO blinkit_meta (key, value) VALUES ('cn_seq', '0') ON CONFLICT(key) DO UPDATE SET value='0'`)
          ]);
          return json({ ok: true });
        }

        // ── BLINKIT INVOICE — [TEMP] delete ONE invoice by RO number ──────
        if (act === 'blinkitDeleteInvoiceByRO') {
          await ensureBlinkitTables(env.DB);
          const { ro_number } = body;
          if (!ro_number) return json({ ok: false, error: 'ro_number required' }, 400);
          const result = await env.DB.prepare(
            'DELETE FROM blinkit_invoices WHERE ro_number = ?'
          ).bind(ro_number).run();
          return json({ ok: true, deleted: result.meta.changes });
        }

        // ── FLIPKART LABEL GENERATOR — upsert one consignment ledger row ──
        if (act === 'fkLedgerSave') {
          await ensureFkLedgerTable(env.DB);
          const {
            consignment_no, dc_date, appointment_date, warehouse,
            no_of_sku, total_qty, send_qty, received_qty, status,
            items_json, shortage_json, receipt_shortage_json, created_at, updated_at
          } = body;
          if (!consignment_no) return json({ ok: false, error: 'consignment_no required' }, 400);
          await env.DB.prepare(`
            INSERT INTO fk_ledger (consignment_no, dc_date, appointment_date, warehouse, no_of_sku, total_qty, send_qty, received_qty, status, items_json, shortage_json, receipt_shortage_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(consignment_no) DO UPDATE SET
              dc_date=excluded.dc_date, appointment_date=excluded.appointment_date,
              warehouse=excluded.warehouse, no_of_sku=excluded.no_of_sku,
              total_qty=excluded.total_qty, send_qty=excluded.send_qty,
              received_qty=excluded.received_qty, status=excluded.status,
              items_json=excluded.items_json, shortage_json=excluded.shortage_json,
              receipt_shortage_json=excluded.receipt_shortage_json,
              updated_at=excluded.updated_at
          `).bind(
            consignment_no, dc_date || '', appointment_date || '', warehouse || '',
            no_of_sku || 0, total_qty || 0, send_qty || 0,
            (received_qty === '' || received_qty == null) ? null : received_qty,
            status || '', items_json || '[]', shortage_json || '[]', receipt_shortage_json || '[]',
            created_at || new Date().toISOString(), updated_at || new Date().toISOString()
          ).run();
          return json({ ok: true });
        }

        // ── FLIPKART LABEL GENERATOR — save SKU library ───────
        if (act === 'fkLibSave') {
          await ensureFkMetaTable(env.DB);
          const { data } = body;
          if (typeof data !== 'string') return json({ ok: false, error: 'data must be a JSON string' }, 400);
          await env.DB.prepare(`
            INSERT INTO fk_meta (key, value) VALUES ('sku_lib', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).bind(data).run();
          return json({ ok: true });
        }

        // ── FLIPKART LABEL GENERATOR — save/confirm pincode mapping ───────
        if (act === 'fkWarehouseMapSave') {
          await ensureFkWarehouseMapTable(env.DB);
          const { pincode, warehouse_name } = body;
          if (!pincode || !warehouse_name) return json({ ok: false, error: 'pincode and warehouse_name required' }, 400);
          await env.DB.prepare(`
            INSERT INTO fk_warehouse_map (pincode, warehouse_name, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(pincode) DO UPDATE SET warehouse_name=excluded.warehouse_name, updated_at=excluded.updated_at
          `).bind(pincode, warehouse_name).run();
          return json({ ok: true });
        }

        // ── FLIPKART LABEL GENERATOR — remove pincode mapping ─────────────
        if (act === 'fkWarehouseMapDelete') {
          await ensureFkWarehouseMapTable(env.DB);
          const { pincode } = body;
          if (!pincode) return json({ ok: false, error: 'pincode required' }, 400);
          await env.DB.prepare('DELETE FROM fk_warehouse_map WHERE pincode = ?').bind(pincode).run();
          return json({ ok: true });
        }

        // ── FLIPKART LABEL GENERATOR — [TEMP] delete ALL ledger rows ──────
        if (act === 'fkLedgerDeleteAll') {
          await ensureFkLedgerTable(env.DB);
          await env.DB.prepare('DELETE FROM fk_ledger').run();
          return json({ ok: true });
        }

        // ── STOCK ALERT — save one manual Qty/box override ───
        // Accepts an optional `confirmed` boolean. Only the Qty/Box Data
        // tab's edit flow sends confirmed:true — every other view (idle,
        // low stock, archived, ideal stock) that also uses this same
        // save action sends confirmed:false (or omits it), since those are
        // quick ad-hoc entries for a transfer, not a deliberate SKU-by-SKU
        // audit. Every save fully overwrites the confirmed flag to match
        // where it came from — a value is only "confirmed" if the most
        // recent save of it happened via the Qty/Box Data tab.
        if (act === 'sa_saveQtyOverride') {
          await ensureSaTables(env.DB);
          const { skuCode, name, qtyPerBox, confirmed } = body;
          if (!skuCode) return json({ ok: false, error: 'skuCode required' }, 400);
          await env.DB.prepare(`
            INSERT INTO sa_qty_overrides (sku_code, name, qty_per_box, confirmed, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(sku_code) DO UPDATE SET
              name = excluded.name,
              qty_per_box = excluded.qty_per_box,
              confirmed = excluded.confirmed,
              updated_at = excluded.updated_at
          `).bind(skuCode, name || '', qtyPerBox || 0, confirmed ? 1 : 0).run();
          return json({ ok: true });
        }

        // ── STOCK ALERT — delete one manual Qty/box override ─
        if (act === 'sa_deleteQtyOverride') {
          await ensureSaTables(env.DB);
          const { skuCode } = body;
          if (!skuCode) return json({ ok: false, error: 'skuCode required' }, 400);
          await env.DB.prepare('DELETE FROM sa_qty_overrides WHERE sku_code = ?').bind(skuCode).run();
          return json({ ok: true });
        }

        // ── STOCK ALERT — bootstrap bulk-import initial overrides ────────
        if (act === 'sa_bulkImportQtyOverrides') {
          await ensureSaTables(env.DB);
          const rows = body.rows || [];
          const BATCH = 20;
          for (let i = 0; i < rows.length; i += BATCH) {
            await Promise.all(rows.slice(i, i + BATCH).map(r =>
              env.DB.prepare(`
                INSERT INTO sa_qty_overrides (sku_code, name, qty_per_box, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(sku_code) DO UPDATE SET
                  name = excluded.name,
                  qty_per_box = excluded.qty_per_box,
                  updated_at = excluded.updated_at
              `).bind(r.skuCode, r.name || '', r.qtyPerBox || 0).run()
            ));
          }
          return json({ ok: true, count: rows.length });
        }

        // ── STOCK ALERT — manually archive one SKU ────────────
        if (act === 'sa_archiveSku') {
          await ensureSaTables(env.DB);
          const { skuCode } = body;
          if (!skuCode) return json({ ok: false, error: 'skuCode required' }, 400);
          await env.DB.prepare(`
            INSERT INTO sa_archived_skus (sku_code, archived_at)
            VALUES (?, datetime('now'))
            ON CONFLICT(sku_code) DO UPDATE SET archived_at = excluded.archived_at
          `).bind(skuCode).run();
          return json({ ok: true });
        }

        // ── STOCK ALERT — un-archive one SKU ──────────────────
        if (act === 'sa_unarchiveSku') {
          await ensureSaTables(env.DB);
          const { skuCode } = body;
          if (!skuCode) return json({ ok: false, error: 'skuCode required' }, 400);
          await env.DB.prepare('DELETE FROM sa_archived_skus WHERE sku_code = ?').bind(skuCode).run();
          return json({ ok: true });
        }

        // ── STOCK ALERT — save one manual Rec. Qty override ───
        if (act === 'sa_saveRecQtyOverride') {
          await ensureSaTables(env.DB);
          const { skuCode, recQty } = body;
          if (!skuCode) return json({ ok: false, error: 'skuCode required' }, 400);
          await env.DB.prepare(`
            INSERT INTO sa_recqty_overrides (sku_code, rec_qty, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(sku_code) DO UPDATE SET
              rec_qty = excluded.rec_qty,
              updated_at = excluded.updated_at
          `).bind(skuCode, recQty || 0).run();
          return json({ ok: true });
        }

        // ── STOCK ALERT — delete one manual Rec. Qty override ─
        if (act === 'sa_deleteRecQtyOverride') {
          await ensureSaTables(env.DB);
          const { skuCode } = body;
          if (!skuCode) return json({ ok: false, error: 'skuCode required' }, 400);
          await env.DB.prepare('DELETE FROM sa_recqty_overrides WHERE sku_code = ?').bind(skuCode).run();
          return json({ ok: true });
        }

        // ── STOCK ALERT — save one manual G4 Total Box count ──
        if (act === 'sa_saveG4BoxCount') {
          await ensureSaTables(env.DB);
          const { skuCode, totalBox } = body;
          if (!skuCode) return json({ ok: false, error: 'skuCode required' }, 400);
          await env.DB.prepare(`
            INSERT INTO sa_g4_box_counts (sku_code, total_box, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(sku_code) DO UPDATE SET
              total_box = excluded.total_box,
              updated_at = excluded.updated_at
          `).bind(skuCode, totalBox || 0).run();
          return json({ ok: true });
        }

        // ── STOCK ALERT — save an app-wide setting ────────────
        if (act === 'sa_saveSettings') {
          await ensureSaTables(env.DB);
          const { key, value } = body;
          if (!key) return json({ ok: false, error: 'key required' }, 400);
          await env.DB.prepare(`
            INSERT INTO sa_settings (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at
          `).bind(key, value == null ? '' : String(value)).run();
          return json({ ok: true });
        }

        return json({ ok: false, error: 'Unknown action' }, 400);
      }

      return json({ ok: false, error: 'Method not allowed' }, 405);

    } catch (err) {
      console.error('Worker error:', err);
      return json({ ok: false, error: err.message }, 500);
    }
  },

  // ── SCHEDULED — Cron trigger entry point ────────────────────────────
  // Set up in Cloudflare Dashboard: Workers & Pages → tomahawk-returns →
  // Settings → Trigger events → Cron Trigger (e.g. "*/15 * * * *" for
  // every 15 minutes). Runs checkNewRoEmails() automatically with no
  // page load, no manual trigger, no Claude involvement needed.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      checkNewRoEmails(env).catch(err => {
        console.error('scheduled RO email check failed:', err.message);
      })
    );
  }
};

// ══════════════════════════════════════════════════════════════════
// BLINKIT RO EMAIL WATCHER — Gmail API integration
// ══════════════════════════════════════════════════════════════════
// Reads naimuddin@bullet.co.in via the Gmail API (read-only scope),
// searches for "RO created/edited" notification emails (label:Blinkit,
// subject starting with RO_), parses the RO Number / Creation Date /
// Expiration Date / Bill-To warehouse out of the email body, and logs
// each one exactly once into blinkit_ro_log — deduped by Gmail message
// ID, so re-running this (via cron or manual trigger) never double-logs
// the same email. Phase 1 only: detection + logging, no UI wiring yet,
// no PDF attachment handling yet.
// ══════════════════════════════════════════════════════════════════

const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function ensureBlinkitRoTable(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS blinkit_ro_log (
    gmail_msg_id    TEXT PRIMARY KEY,
    ro_number       TEXT,
    creation_date   TEXT,
    expiration_date TEXT,
    warehouse       TEXT,
    subject         TEXT,
    gmail_link      TEXT,
    detected_at     TEXT DEFAULT (datetime('now'))
  )`).run();
}

// Exchanges the long-lived refresh token for a short-lived access token.
// Called fresh on every check — access tokens expire in ~1hr, and Workers
// don't persist in-memory state between invocations anyway, so there's no
// benefit to caching it here.
async function getGmailAccessToken(env) {
  const res = await fetch(GMAIL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error('Gmail token refresh failed: ' + res.status + ' ' + errText);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('No access_token in Gmail token response');
  return data.access_token;
}

// Gmail message bodies come base64url-encoded (not standard base64) —
// swap the URL-safe chars back, pad it out, then decode as UTF-8 so
// non-ASCII characters in the email don't come out garbled.
function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// Gmail messages are a tree of MIME parts. Prefer the plain-text part;
// if only HTML is present, strip tags as a fallback (good enough for
// regex parsing, not meant to be human-readable).
function extractGmailBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return base64UrlDecode(payload.body.data);
  }
  if (payload.parts && payload.parts.length) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return base64UrlDecode(part.body.data);
      }
    }
    for (const part of payload.parts) {
      const nested = extractGmailBody(part);
      if (nested) return nested;
    }
  }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    const html = base64UrlDecode(payload.body.data);
    return html.replace(/<[^>]+>/g, ' ');
  }
  return '';
}

// Parses the fixed-format fields out of a Blinkit "RO created/edited"
// email body. Matches the exact wording seen in the reference email:
//   R.O. Number: 43886110067504
//   Creation Date: 2026-08-11
//   Expiration Date: 2026-09-10 18:29:00+00:00
//   Bill To: BCPL - Pune P3 Feeder Warehouse
function parseRoEmailBody(text) {
  const roMatch        = text.match(/R\.?O\.?\s*Number\s*:\s*([A-Za-z0-9]+)/i);
  const creationMatch  = text.match(/Creation Date\s*:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
  const expiryMatch    = text.match(/Expiration Date\s*:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[^\n\r]*)/i);
  const warehouseMatch = text.match(/Bill To\s*:\s*([^\n\r]+)/i);
  return {
    ro_number:       roMatch ? roMatch[1].trim() : null,
    creation_date:   creationMatch ? creationMatch[1].trim() : null,
    expiration_date: expiryMatch ? expiryMatch[1].trim() : null,
    warehouse:       warehouseMatch ? warehouseMatch[1].trim() : null
  };
}

// Main check: search Gmail for RO emails, skip ones already logged
// (by Gmail message ID), parse + insert the rest. Safe to call as
// often as needed — re-running never creates duplicate rows.
async function checkNewRoEmails(env) {
  await ensureBlinkitRoTable(env.DB);
  const accessToken = await getGmailAccessToken(env);

  const query = encodeURIComponent('label:Blinkit "R.O. Number"');
  const listRes = await fetch(`${GMAIL_API_BASE}/messages?q=${query}&maxResults=20`, {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (!listRes.ok) throw new Error('Gmail list failed: ' + listRes.status);
  const listData = await listRes.json();
  const messages = listData.messages || [];

  let newCount = 0;
  for (const m of messages) {
    const exists = await env.DB.prepare(
      'SELECT 1 FROM blinkit_ro_log WHERE gmail_msg_id = ?'
    ).bind(m.id).first();
    if (exists) continue;

    const msgRes = await fetch(`${GMAIL_API_BASE}/messages/${m.id}?format=full`, {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (!msgRes.ok) continue; // skip a single bad message rather than failing the whole batch
    const msg = await msgRes.json();

    const headers = (msg.payload && msg.payload.headers) || [];
    const subjectHeader = headers.find(h => h.name === 'Subject');
    const subject = subjectHeader ? subjectHeader.value : '';

    const bodyText = extractGmailBody(msg.payload);
    const parsed = parseRoEmailBody(bodyText);
    const gmailLink = `https://mail.google.com/mail/u/0/#all/${m.id}`;

    await env.DB.prepare(`
      INSERT INTO blinkit_ro_log (gmail_msg_id, ro_number, creation_date, expiration_date, warehouse, subject, gmail_link, detected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(gmail_msg_id) DO NOTHING
    `).bind(m.id, parsed.ro_number, parsed.creation_date, parsed.expiration_date, parsed.warehouse, subject, gmailLink).run();

    newCount++;
  }

  return { checked: messages.length, newLogged: newCount };
}

// ══════════════════════════════════════════════════════════════════
// LABEL GENERATOR — Table Bootstrap
// ══════════════════════════════════════════════════════════════════
async function ensureLibTable(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS sku_library (
    model_name   TEXT PRIMARY KEY,
    category     TEXT,
    mrp          TEXT,
    brand        TEXT DEFAULT 'tomahawk',
    sales        TEXT,
    dims         TEXT,
    mfgdate      TEXT,
    fk_skus_json TEXT DEFAULT '[]',
    updated_at   TEXT DEFAULT (datetime('now'))
  )`).run();
}

// ══════════════════════════════════════════════════════════════════
// FLIPKART LABEL GENERATOR — Table Bootstrap
// ══════════════════════════════════════════════════════════════════
async function ensureFkLedgerTable(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS fk_ledger (
    consignment_no    TEXT PRIMARY KEY,
    dc_date           TEXT DEFAULT '',
    appointment_date  TEXT DEFAULT '',
    warehouse         TEXT DEFAULT '',
    no_of_sku         INTEGER DEFAULT 0,
    total_qty         INTEGER DEFAULT 0,
    send_qty          INTEGER DEFAULT 0,
    received_qty      INTEGER DEFAULT NULL,
    status            TEXT DEFAULT '',
    items_json        TEXT DEFAULT '[]',
    shortage_json     TEXT DEFAULT '[]',
    receipt_shortage_json TEXT DEFAULT '[]',
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now'))
  )`).run();
  const migrations = [
    `ALTER TABLE fk_ledger ADD COLUMN items_json    TEXT DEFAULT '[]'`,
    `ALTER TABLE fk_ledger ADD COLUMN shortage_json TEXT DEFAULT '[]'`,
    `ALTER TABLE fk_ledger ADD COLUMN receipt_shortage_json TEXT DEFAULT '[]'`
  ];
  for (const sql of migrations) {
    try { await DB.prepare(sql).run(); } catch(e) { /* column already exists — safe to ignore */ }
  }
}

async function ensureFkWarehouseMapTable(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS fk_warehouse_map (
    pincode        TEXT PRIMARY KEY,
    warehouse_name TEXT NOT NULL,
    updated_at     TEXT DEFAULT (datetime('now'))
  )`).run();
}

async function ensureFkMetaTable(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS fk_meta (
    key   TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
  )`).run();
}

// ══════════════════════════════════════════════════════════════════
// GATE PASS — Table Bootstrap
// ══════════════════════════════════════════════════════════════════
async function ensureGpTables(DB) {
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS gp_image_cache (
      uc_sku     TEXT PRIMARY KEY,
      image_url  TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS sku_map (
      uc_sku         TEXT PRIMARY KEY,
      internal_sku   TEXT,
      pcs_per_carton INTEGER,
      image_url      TEXT,
      category       TEXT,
      source         TEXT DEFAULT 'inline'
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS box_counters (
      key  TEXT PRIMARY KEY,
      seq  INTEGER DEFAULT 0
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS gp_bw_images (
      uc_sku        TEXT PRIMARY KEY,
      bw_image_url  TEXT NOT NULL,
      bw_source_url TEXT NOT NULL DEFAULT '',
      updated_at    TEXT DEFAULT (datetime('now'))
    )`)
  ]);
}

// ══════════════════════════════════════════════════════════════════
// SKU MASTER — Table Bootstrap
// ══════════════════════════════════════════════════════════════════
async function ensureSkuMasterTable(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS sku_master (
    uc_sku        TEXT PRIMARY KEY,
    internal_sku  TEXT,
    category      TEXT,
    qty_per_box   INTEGER,
    image_url     TEXT,
    bw_image_url  TEXT,
    bw_source_url TEXT,
    updated_at    TEXT DEFAULT (datetime('now')),
    updated_by    TEXT DEFAULT ''
  )`).run();
}

async function upsertSkuMaster(DB, r) {
  if (!r || !r.ucSku) return;
  await DB.prepare(`
    INSERT INTO sku_master (uc_sku, internal_sku, category, qty_per_box, image_url, bw_image_url, bw_source_url, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(uc_sku) DO UPDATE SET
      internal_sku  = COALESCE(excluded.internal_sku, sku_master.internal_sku),
      category      = COALESCE(excluded.category, sku_master.category),
      qty_per_box   = COALESCE(excluded.qty_per_box, sku_master.qty_per_box),
      image_url     = COALESCE(excluded.image_url, sku_master.image_url),
      bw_image_url  = COALESCE(excluded.bw_image_url, sku_master.bw_image_url),
      bw_source_url = COALESCE(excluded.bw_source_url, sku_master.bw_source_url),
      updated_at    = excluded.updated_at,
      updated_by    = excluded.updated_by
  `).bind(
    r.ucSku,
    r.internalSku != null ? r.internalSku : null,
    r.category != null ? r.category : null,
    r.qtyPerBox != null ? r.qtyPerBox : null,
    r.imageUrl != null ? r.imageUrl : null,
    r.bwImageUrl != null ? r.bwImageUrl : null,
    r.bwSourceUrl != null ? r.bwSourceUrl : null,
    r.updatedBy || ''
  ).run();
}

async function ensureGpSettingsTable(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS gp_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
}

// ══════════════════════════════════════════════════════════════════
// UC SKU LIST CACHE — Table Bootstrap
// ══════════════════════════════════════════════════════════════════
async function ensureUcSkuCacheTable(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS uc_sku_cache (
    key        TEXT PRIMARY KEY,
    value      TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
}

// ══════════════════════════════════════════════════════════════════
// STOCK TAKING — Table Bootstrap
// ══════════════════════════════════════════════════════════════════
async function ensureStockTables(DB) {
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS stock_master (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL, name TEXT,
      qty INTEGER NOT NULL DEFAULT 0, box_num INTEGER DEFAULT 1,
      counted_by TEXT, date TEXT, notes TEXT, saved INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS stock_loose (
      id TEXT PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT,
      qty INTEGER NOT NULL DEFAULT 0, location TEXT, date TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS stock_uc_disable (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL, note TEXT, date TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS stock_settings (
      key TEXT PRIMARY KEY, value TEXT, updated_at TEXT
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS bin_allotment (
      sku TEXT PRIMARY KEY, bin TEXT
    )`)
  ]);
}

// ══════════════════════════════════════════════════════════════════
// SCANNER — Table Bootstrap
// ══════════════════════════════════════════════════════════════════
async function ensureScannerTables(DB) {
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS scanner_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS scanner_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), closed_at TEXT
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS scanner_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL,
      type TEXT NOT NULL, scanned_by TEXT NOT NULL,
      scanned_at TEXT DEFAULT (datetime('now')),
      box_id TEXT DEFAULT ''
    )`)
  ]);
  try { await DB.prepare(`ALTER TABLE scanner_records ADD COLUMN box_id TEXT DEFAULT ''`).run(); } catch(e) { /* column already exists — safe to ignore */ }
  const adminExists = await DB.prepare("SELECT id FROM scanner_users WHERE username = 'admin'").first();
  if (!adminExists) {
    await DB.prepare("INSERT INTO scanner_users (username, password, role) VALUES ('admin', 'tomahawk@2026', 'admin')").run();
  }
}

// ══════════════════════════════════════════════════════════════════
// BLINKIT INVOICE — Table Bootstrap
// ══════════════════════════════════════════════════════════════════
async function ensureBlinkitTables(DB) {
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS blinkit_invoices (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ro_number     TEXT UNIQUE NOT NULL,
      inv_number    TEXT NOT NULL,
      seq           INTEGER DEFAULT 1,
      warehouse     TEXT DEFAULT '',
      inv_date      TEXT DEFAULT '',
      inv_html      TEXT DEFAULT '',
      sku_count     INTEGER DEFAULT 0,
      total_qty     INTEGER DEFAULT 0,
      items_json    TEXT DEFAULT '[]',
      received_qty  INTEGER DEFAULT NULL,
      received_at   TEXT DEFAULT '',
      status_note   TEXT DEFAULT '',
      created_at    TEXT DEFAULT (datetime('now'))
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS blinkit_meta (
      key   TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS blinkit_credit_notes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cn_number   TEXT UNIQUE NOT NULL,
      inv_number  TEXT NOT NULL,
      ro_number   TEXT DEFAULT '',
      reason      TEXT DEFAULT '',
      items_json  TEXT DEFAULT '[]',
      total_qty   INTEGER DEFAULT 0,
      amount      REAL DEFAULT 0,
      cn_html     TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now'))
    )`)
  ]);
  const migrations = [
    `ALTER TABLE blinkit_invoices ADD COLUMN sku_count    INTEGER DEFAULT 0`,
    `ALTER TABLE blinkit_invoices ADD COLUMN total_qty    INTEGER DEFAULT 0`,
    `ALTER TABLE blinkit_invoices ADD COLUMN items_json   TEXT DEFAULT '[]'`,
    `ALTER TABLE blinkit_invoices ADD COLUMN received_qty INTEGER DEFAULT NULL`,
    `ALTER TABLE blinkit_invoices ADD COLUMN received_at  TEXT DEFAULT ''`,
    `ALTER TABLE blinkit_invoices ADD COLUMN status_note  TEXT DEFAULT ''`,
  ];
  for (const sql of migrations) {
    try { await DB.prepare(sql).run(); } catch(e) { /* column already exists — safe to ignore */ }
  }
}

// ══════════════════════════════════════════════════════════════════
// STOCK ALERT — Table Bootstrap
// ══════════════════════════════════════════════════════════════════
async function ensureSaTables(DB) {
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS sa_qty_overrides (
      sku_code    TEXT PRIMARY KEY,
      name        TEXT DEFAULT '',
      qty_per_box INTEGER DEFAULT 0,
      confirmed   INTEGER DEFAULT 0,
      updated_at  TEXT DEFAULT (datetime('now'))
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS sa_archived_skus (
      sku_code    TEXT PRIMARY KEY,
      archived_at TEXT DEFAULT (datetime('now'))
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS sa_recqty_overrides (
      sku_code   TEXT PRIMARY KEY,
      rec_qty    INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS sa_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS sa_g4_box_counts (
      sku_code   TEXT PRIMARY KEY,
      total_box  INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )`)
  ]);
  // Migration for existing D1 instances created before the `confirmed`
  // column existed — CREATE TABLE IF NOT EXISTS above won't add it to an
  // already-existing sa_qty_overrides table, so ALTER it in separately.
  try { await DB.prepare(`ALTER TABLE sa_qty_overrides ADD COLUMN confirmed INTEGER DEFAULT 0`).run(); } catch(e) { /* column already exists — safe to ignore */ }
}

// ══════════════════════════════════════════════════════════════════
// RETURNS MANAGER — Helpers
// ══════════════════════════════════════════════════════════════════
async function upsertReturn(DB, r) {
  return DB.prepare(`
    INSERT INTO returns (
      id, tracking, order_id, product, sku, qty, price, date, platform,
      return_reason, condition, status, claim_needed, claim_ref,
      claim_resolution, claim_approved_amt, claim_note, putaway, maint_done,
      maint_result, repair_status, repairer_name, handed_over_at,
      received_from_repairer_at, trash_reason, trashed_at, note, fnsku,
      removal_order_id, disposition, fba_qty, actual_sku, sug_cond,
      sub_reason, customer_comment, return_status, fsn,
      created_at, processed_at, resolved_at, updated_at
    ) VALUES (
      ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      tracking=excluded.tracking, order_id=excluded.order_id,
      product=excluded.product, sku=excluded.sku, qty=excluded.qty,
      price=excluded.price, date=excluded.date, platform=excluded.platform,
      return_reason=excluded.return_reason, condition=excluded.condition,
      status=excluded.status, claim_needed=excluded.claim_needed,
      claim_ref=excluded.claim_ref, claim_resolution=excluded.claim_resolution,
      claim_approved_amt=excluded.claim_approved_amt, claim_note=excluded.claim_note,
      putaway=excluded.putaway, maint_done=excluded.maint_done,
      maint_result=excluded.maint_result, repair_status=excluded.repair_status,
      repairer_name=excluded.repairer_name, handed_over_at=excluded.handed_over_at,
      received_from_repairer_at=excluded.received_from_repairer_at,
      trash_reason=excluded.trash_reason, trashed_at=excluded.trashed_at,
      note=excluded.note, fnsku=excluded.fnsku,
      removal_order_id=excluded.removal_order_id, disposition=excluded.disposition,
      fba_qty=excluded.fba_qty, actual_sku=excluded.actual_sku,
      sug_cond=excluded.sug_cond, sub_reason=excluded.sub_reason,
      customer_comment=excluded.customer_comment, return_status=excluded.return_status,
      fsn=excluded.fsn, processed_at=excluded.processed_at,
      resolved_at=excluded.resolved_at, updated_at=datetime('now')
  `).bind(
    r.id, r.tracking||null, r.orderId||null, r.product||null, r.sku||null,
    r.qty||1, r.price||null, r.date||null, r.platform||'Flipkart B2C',
    r.returnReason||null, r.condition||null, r.status||'Return Pending',
    r.claimNeeded?1:0, r.claimRef||null, r.claimResolution||null,
    r.claimApprovedAmt||null, r.claimNote||null,
    r.putaway?1:0, r.maintDone?1:0, r.maintResult||null,
    r.repairStatus||null, r.repairerName||null, r.handedOverAt||null,
    r.receivedFromRepairerAt||null, r.trashReason||null, r.trashedAt||null,
    r.note||null, r.fnsku||null, r.removalOrderId||null, r.disposition||null,
    r.fbaQty||null, r.actualSku||null, r.sugCond||null, r.subReason||null,
    r.customerComment||null, r.returnStatus||null, r.fsn||null,
    r.createdAt||new Date().toISOString(), r.processedAt||null, r.resolvedAt||null
  ).run();
}

async function upsertFba(DB, r) {
  return DB.prepare(`
    INSERT INTO fba_returns (id, tracking, order_id, request_date, carrier, ship_status, disposition, platform, status, lines_count, data, created_at, processed_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      tracking=excluded.tracking, status=excluded.status,
      ship_status=excluded.ship_status, disposition=excluded.disposition,
      data=excluded.data, updated_at=datetime('now')
  `).bind(
    r.id, r.tracking||null, r.orderId||null, r.requestDate||null,
    r.carrier||null, r.shipStatus||null, r.disposition||null,
    r.platform||'Amazon FBA', r.status||null,
    (r.lines||[]).length, JSON.stringify(r),
    r.createdAt||new Date().toISOString(), r.processedAt||null
  ).run();
}

function rowToReturn(row) {
  return {
    id: row.id, tracking: row.tracking, orderId: row.order_id,
    product: row.product, sku: row.sku, qty: row.qty,
    price: row.price, date: row.date, platform: row.platform,
    returnReason: row.return_reason, condition: row.condition, status: row.status,
    claimNeeded: row.claim_needed === 1, claimRef: row.claim_ref||'',
    claimResolution: row.claim_resolution||'',
    claimApprovedAmt: row.claim_approved_amt||'', claimNote: row.claim_note||'',
    putaway: row.putaway === 1, maintDone: row.maint_done === 1,
    maintResult: row.maint_result||'', repairStatus: row.repair_status||'',
    repairerName: row.repairer_name||'', handedOverAt: row.handed_over_at||'',
    receivedFromRepairerAt: row.received_from_repairer_at||'',
    trashReason: row.trash_reason||'', trashedAt: row.trashed_at||'',
    note: row.note||'', fnsku: row.fnsku||'', removalOrderId: row.removal_order_id||'',
    disposition: row.disposition||'', fbaQty: row.fba_qty||'',
    actualSku: row.actual_sku||'', sugCond: row.sug_cond||'',
    subReason: row.sub_reason||'', customerComment: row.customer_comment||'',
    returnStatus: row.return_status||'', fsn: row.fsn||'',
    createdAt: row.created_at||'', processedAt: row.processed_at||'',
    resolvedAt: row.resolved_at||''
  };
}
