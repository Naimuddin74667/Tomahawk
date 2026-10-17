/* ═══════════════════════════════════════════════════════════════════
   MNS Tours & Travels — Cloudflare Worker (separate account from Tomahawk)

   Needs (Worker → Settings):
     • D1 database binding named  DB
     • Secret named               ADMIN_KEY  (used only for the very first owner login)

   Logins
     Owner   (you):   mobile number + password → full access
     Viewer  (Uncle): mobile number + password → sees everything, cannot change anything
     Driver:               mobile number only → read-only view of his own rent

   Endpoints
     POST /login        {mobile, password}          → {token, name, mobile}
                        First ever login: password = ADMIN_KEY creates the first owner.
     POST /logout                                   (owner)
     GET  /me                                       (owner) → {name, mobile}
     GET  /users                                    (logged in) → login list
     POST /users        {mobile, name, password, role}  owner: add/update any login; viewer: own password only
     DELETE /users?mobile=…                         (owner)
     GET  /state                                    (owner) → whole app data
     PUT  /state        {data, savedAt, force?}     (owner)
     GET  /driver?mobile=…  (or ?code=… old links)  → that driver's rent only
   ═══════════════════════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const mobile10 = m => String(m || '').replace(/\D/g, '').slice(-10);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return hex(bits);
}

async function setupTables(DB) {
  await DB.batch([
    DB.prepare('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL, saved_at TEXT NOT NULL)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS users (mobile TEXT PRIMARY KEY, name TEXT, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, mobile TEXT NOT NULL, created_at TEXT)'),
  ]);
  // role: 'owner' (full access) or 'viewer' (read-only). Added later, so add the column if missing.
  try { await DB.prepare("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'owner'").run(); } catch (e) { /* already there */ }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.DB) return json({ error: 'D1 binding "DB" is missing' }, 500);
    const DB = env.DB;
    await setupTables(DB);

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const body = ['POST', 'PUT'].includes(req.method) ? await req.json().catch(() => ({})) : {};
    const row = () => DB.prepare('SELECT data, saved_at FROM app_state WHERE id = 1').first();

    // Who is calling? (owner session token, or the old admin key)
    const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    let owner = null;
    if (bearer) owner = await DB.prepare(
      "SELECT u.mobile, u.name, COALESCE(u.role, 'owner') AS role FROM sessions s JOIN users u ON u.mobile = s.mobile WHERE s.token = ?1").bind(bearer).first();
    if (!owner && env.ADMIN_KEY && req.headers.get('X-Admin-Key') === env.ADMIN_KEY) owner = { mobile: '', name: 'Admin', role: 'owner' };
    const needOwner = () => json({ error: 'Please log in' }, 401);
    const canEdit = owner && owner.role === 'owner';
    const viewOnly = () => json({ error: 'View-only login — changes are not allowed' }, 403);

    try {
      if (path === '/') return json({ ok: true, app: 'MNS Tours & Travels' });

      /* ── Owner login ── */
      if (path === '/login' && req.method === 'POST') {
        const m = mobile10(body.mobile), pw = String(body.password || '');
        if (m.length !== 10 || !pw) return json({ error: 'Enter your 10-digit mobile number and password' }, 400);
        let user = await DB.prepare('SELECT * FROM users WHERE mobile = ?1').bind(m).first();
        if (!user) {
          const count = (await DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n;
          // Very first login sets up the first owner, using the ADMIN_KEY secret as the password
          if (count === 0 && env.ADMIN_KEY && pw === env.ADMIN_KEY) {
            const salt = randomHex(16);
            await DB.prepare("INSERT INTO users (mobile, name, salt, hash, created_at, role) VALUES (?1, ?2, ?3, ?4, ?5, 'owner')")
              .bind(m, body.name || 'Owner', salt, await hashPassword(pw, salt), new Date().toISOString()).run();
            user = await DB.prepare('SELECT * FROM users WHERE mobile = ?1').bind(m).first();
          } else return json({ error: 'Wrong mobile number or password' }, 401);
        } else if (await hashPassword(pw, user.salt) !== user.hash) {
          return json({ error: 'Wrong mobile number or password' }, 401);
        }
        const token = randomHex(32);
        await DB.prepare('INSERT INTO sessions (token, mobile, created_at) VALUES (?1, ?2, ?3)')
          .bind(token, m, new Date().toISOString()).run();
        return json({ token, name: user.name, mobile: m, role: user.role || 'owner' });
      }

      if (path === '/logout' && req.method === 'POST') {
        if (bearer) await DB.prepare('DELETE FROM sessions WHERE token = ?1').bind(bearer).run();
        return json({ ok: true });
      }

      if (path === '/me') return owner ? json(owner) : needOwner();

      /* ── Owner accounts ── */
      if (path === '/users') {
        if (!owner) return needOwner();
        if (req.method === 'GET') {
          const r = await DB.prepare("SELECT mobile, name, COALESCE(role, 'owner') AS role FROM users ORDER BY created_at").all();
          return json({ users: r.results || [] });
        }
        if (req.method === 'POST') {
          const m = mobile10(body.mobile), pw = String(body.password || '');
          // A viewer may only change their own password
          if (!canEdit && m !== owner.mobile) return viewOnly();
          const role = canEdit ? (body.role === 'viewer' ? 'viewer' : 'owner') : 'viewer';
          if (canEdit && m === owner.mobile && role !== 'owner') return json({ error: 'You can’t make your own login view-only' }, 400);
          if (m.length !== 10) return json({ error: 'Enter a 10-digit mobile number' }, 400);
          if (pw.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400);
          const salt = randomHex(16), h = await hashPassword(pw, salt);
          await DB.prepare('INSERT INTO users (mobile, name, salt, hash, created_at, role) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ' +
            'ON CONFLICT(mobile) DO UPDATE SET name = excluded.name, salt = excluded.salt, hash = excluded.hash, role = excluded.role')
            .bind(m, body.name || 'Owner', salt, h, new Date().toISOString(), role).run();
          return json({ ok: true });
        }
        if (req.method === 'DELETE') {
          if (!canEdit) return viewOnly();
          const m = mobile10(url.searchParams.get('mobile'));
          if (m === owner.mobile) return json({ error: 'You can’t remove your own login' }, 400);
          await DB.batch([DB.prepare('DELETE FROM users WHERE mobile = ?1').bind(m),
                          DB.prepare('DELETE FROM sessions WHERE mobile = ?1').bind(m)]);
          return json({ ok: true });
        }
      }

      /* ── App data (owners only) ── */
      if (path === '/state') {
        if (!owner) return needOwner();
        if (req.method === 'GET') {
          const r = await row();
          return json(r ? { data: JSON.parse(r.data), savedAt: r.saved_at } : { data: null, savedAt: null });
        }
        if (req.method === 'PUT') {
          if (!canEdit) return viewOnly();
          if (!body.data || !body.savedAt) return json({ error: 'data and savedAt required' }, 400);
          const r = await row();
          // Don't let an older copy (e.g. a phone that was offline) overwrite newer data
          if (r && r.saved_at > body.savedAt && !body.force) {
            return json({ error: 'conflict', data: JSON.parse(r.data), savedAt: r.saved_at }, 409);
          }
          await DB.prepare('INSERT INTO app_state (id, data, saved_at) VALUES (1, ?1, ?2) ' +
            'ON CONFLICT(id) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at')
            .bind(JSON.stringify(body.data), body.savedAt).run();
          return json({ ok: true, savedAt: body.savedAt });
        }
      }

      /* ── Driver view (mobile number only, read-only) ── */
      if (path === '/driver' && req.method === 'GET') {
        const m = mobile10(url.searchParams.get('mobile')), code = (url.searchParams.get('code') || '').trim();
        if (m.length !== 10 && code.length < 6) return json({ error: 'Enter your 10-digit mobile number' }, 400);
        const r = await row();
        if (!r) return json({ error: 'Not set up yet' }, 404);
        const d = JSON.parse(r.data);
        const drv = (d.drivers || []).find(x => !x.endDate && (m.length === 10 ? mobile10(x.phone) === m : x.accessCode === code))
                 || (d.drivers || []).find(x => (m.length === 10 ? mobile10(x.phone) === m : x.accessCode === code));
        if (!drv) return json({ error: 'This mobile number is not registered. Please ask the owner.' }, 404);
        // Only what the driver needs — nothing about loan, expenses or partners
        return json({
          business: 'MNS Tours & Travels',
          car: { name: d.car?.name || '', regNo: d.car?.regNo || '' },
          upi: { id: d.car?.upiId || '', name: d.car?.upiName || 'MNS Tours and Travels' },
          driver: { id: drv.id, name: drv.name, rentCycle: drv.rentCycle, rentAmount: drv.rentAmount,
                    startDate: drv.startDate, endDate: drv.endDate || '' },
          payments: (d.payments || []).filter(p => p.driverId === drv.id)
                      .map(p => ({ date: p.date, amount: p.amount, mode: p.mode })),
          offs: (d.offs || []).filter(o => o.driverId === drv.id).map(o => ({ date: o.date, half: o.half })),
          updatedAt: r.saved_at,
        });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
