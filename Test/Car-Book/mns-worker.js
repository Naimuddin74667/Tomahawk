/* ═══════════════════════════════════════════════════════════════════
   MNS Tours & Travels — Cloudflare Worker (separate account from Tomahawk)

   Needs (Worker → Settings):
     • D1 database binding named  DB
     • Secret named               ADMIN_KEY  (only for the very first login)

   Users — all log in on the same page with mobile number + PIN/password:
     owner    full access (you)
     viewer   sees everything, can't change anything (Uncle)
     manager  Driver Manager (Naushad): pays his own rent to the owner ("I've paid"),
              and keeps the Driver Ledger for the drivers under him
              (was called "driver" before — renamed once, automatically)
     driver   a driver under the manager: sees only his own ledger, read-only
   The owner creates users; the server generates a 6-digit PIN for each.
   The manager can also create logins for the drivers in his ledger.
   5 wrong attempts lock that mobile number for 15 minutes.

   Endpoints
     POST   /login           {mobile, password}   → {token, name, mobile, role, driverId}
     POST   /logout
     GET    /me
     GET    /users                         owner, viewer
     POST   /users           {mobile, name, role, driverId}            owner → {pin}
     POST   /users/reset-pin {mobile}                                  owner → {pin}
     POST   /users/password  {password}    any logged-in user sets their own password
     DELETE /users?mobile=…                owner
     GET    /state                         owner, viewer
     PUT    /state           {data, savedAt, force?}                   owner
     GET    /driver                        driver → his own rent only (+ his "I've paid" claims)
     POST   /driver/claim    {amount, label}            driver says "I've paid" → waits for owner
     POST   /driver/claim/cancel {id}                    driver withdraws a claim still waiting
     POST   /claims/resolve  {id, status}                owner: 'accepted' | 'rejected'

   Driver Ledger (what a driver under the manager owes him in cash)
     Driver owes = daily rent − platform money (Uber/Ola/…) that reached the manager's bank − cash given
     GET    /ledger                        owner/viewer: all · manager: his drivers · driver: only himself
     POST   /ledger/driver   {id?, name, mobile, rent, startDate, endDate}     owner, manager
     POST   /ledger/entry    {id?, driverId, date, kind, platform, amount, note} owner, manager
                             kind: 'credit' (platform → bank) | 'cash' (driver gave cash) | 'waive' (rent not charged)
     POST   /ledger/entry/delete {id}                                          owner, manager
     POST   /ledger/login    {driverId}    owner, manager → new PIN for that driver's login
   GET /state also returns the claims still waiting, so the owner app can ask "Received?".
   ═══════════════════════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const mobile10 = m => String(m || '').replace(/\D/g, '').slice(-10);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const newPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
const now = () => new Date().toISOString();
const ROLES = ['owner', 'viewer', 'manager', 'driver'];
const DEFAULT_PLATFORMS = ['Uber', 'Ola', 'Rapido', 'Other'];
const KINDS = ['credit', 'cash', 'waive'];
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const money = v => Math.round(Number(v) * 100) / 100;

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
    // Driver "I've paid" notices, kept apart from the app data so a driver can never change real records
    DB.prepare('CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, driver_id TEXT NOT NULL, driver_name TEXT, amount REAL NOT NULL, ' +
               "label TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT, resolved_at TEXT, resolved_by TEXT)"),
  ]);
  // Columns added over time — add them if this database is older
  for (const col of ["role TEXT DEFAULT 'owner'", 'driver_id TEXT', 'fails INTEGER DEFAULT 0', 'lock_until TEXT']) {
    try { await DB.prepare('ALTER TABLE users ADD COLUMN ' + col).run(); } catch (e) { /* already there */ }
  }
  // which rent day a driver's "I've paid" is for (start date of that day's period)
  try { await DB.prepare('ALTER TABLE claims ADD COLUMN day TEXT').run(); } catch (e) { /* already there */ }

  // Driver Ledger: drivers under a manager + their entries (platform credits, cash given, waived days)
  await DB.batch([
    DB.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS ld_drivers (id TEXT PRIMARY KEY, name TEXT NOT NULL, mobile TEXT, rent REAL NOT NULL, ' +
               'start_date TEXT NOT NULL, end_date TEXT, manager_mobile TEXT, created_at TEXT)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS ld_entries (id TEXT PRIMARY KEY, driver_id TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, ' +
               'platform TEXT, amount REAL NOT NULL, note TEXT, created_by TEXT, created_at TEXT, deleted INTEGER DEFAULT 0)'),
  ]);
  const done = async k => !!(await DB.prepare('SELECT v FROM meta WHERE k = ?1').bind(k).first());
  const mark = k => DB.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?1, ?2)').bind(k, now()).run();

  // One-time: the old "driver" login (Naushad) becomes "manager" — new driver logins come after this
  if (!await done('roles_v2')) {
    await DB.prepare("UPDATE users SET role = 'manager' WHERE role = 'driver'").run();
    await mark('roles_v2');
  }
  // One-time: start Siddique's ledger on 16 Oct 2026 with the three Uber payouts already matched
  if (!await done('seed_ledger_v1')) {
    const n = (await DB.prepare('SELECT COUNT(*) AS n FROM ld_drivers').first()).n;
    if (n === 0) {
      const mgr = await DB.prepare("SELECT mobile FROM users WHERE role = 'manager' ORDER BY created_at LIMIT 1").first();
      const id = randomHex(6), t = now(), stmts = [
        DB.prepare("INSERT INTO ld_drivers (id, name, mobile, rent, start_date, end_date, manager_mobile, created_at) VALUES (?1, 'Siddique Aabdeen', '', 600, '2026-10-16', NULL, ?2, ?3)")
          .bind(id, mgr ? mgr.mobile : null, t)];
      for (const [date, amt] of [['2026-10-19', 39.89], ['2026-10-20', 614.45], ['2026-10-21', 151.42]])
        stmts.push(DB.prepare("INSERT INTO ld_entries (id, driver_id, date, kind, platform, amount, note, created_by, created_at) VALUES (?1, ?2, ?3, 'credit', 'Uber', ?4, 'Uber Fleet payout', 'setup', ?5)")
          .bind(randomHex(8), id, date, amt, t));
      await DB.batch(stmts);
    }
    await mark('seed_ledger_v1');
  }
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
    const getUser = m => DB.prepare('SELECT * FROM users WHERE mobile = ?1').bind(m).first();

    // Who is calling?
    const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const me = bearer ? await DB.prepare(
      "SELECT u.mobile, u.name, COALESCE(u.role, 'owner') AS role, u.driver_id AS driverId " +
      'FROM sessions s JOIN users u ON u.mobile = s.mobile WHERE s.token = ?1').bind(bearer).first() : null;
    const isOwner = me && me.role === 'owner';
    const isManager = me && me.role === 'manager';
    const canView = me && (me.role === 'owner' || me.role === 'viewer');
    const err = (msg, status) => json({ error: msg }, status);
    const needLogin = () => err('Please log in', 401);
    const notAllowed = () => err('Not allowed for this login', 403);

    try {
      if (path === '/') return json({ ok: true, app: 'MNS Tours & Travels' });

      /* ── Login: mobile + PIN (or password) ── */
      if (path === '/login' && req.method === 'POST') {
        const m = mobile10(body.mobile), pw = String(body.password || '').trim();
        if (m.length !== 10 || !pw) return err('Enter your 10-digit mobile number and PIN', 400);
        let user = await getUser(m);

        if (!user) {
          const count = (await DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n;
          // Very first login creates the first owner, using the ADMIN_KEY secret as the password
          if (count === 0 && env.ADMIN_KEY && pw === env.ADMIN_KEY) {
            const salt = randomHex(16);
            await DB.prepare("INSERT INTO users (mobile, name, salt, hash, created_at, role) VALUES (?1, 'Owner', ?2, ?3, ?4, 'owner')")
              .bind(m, salt, await hashPassword(pw, salt), now()).run();
            user = await getUser(m);
          } else return err('Wrong mobile number or PIN', 401);
        } else {
          if (user.lock_until && user.lock_until > now())
            return err('Too many wrong attempts. Try again in 15 minutes.', 429);
          if (await hashPassword(pw, user.salt) !== user.hash) {
            const fails = (user.fails || 0) + 1;
            const lock = fails >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null;
            await DB.prepare('UPDATE users SET fails = ?1, lock_until = ?2 WHERE mobile = ?3')
              .bind(lock ? 0 : fails, lock, m).run();
            return err(lock ? 'Too many wrong attempts. Try again in 15 minutes.' : 'Wrong mobile number or PIN', 401);
          }
          await DB.prepare('UPDATE users SET fails = 0, lock_until = NULL WHERE mobile = ?1').bind(m).run();
        }
        const token = randomHex(32);
        await DB.prepare('INSERT INTO sessions (token, mobile, created_at) VALUES (?1, ?2, ?3)').bind(token, m, now()).run();
        return json({ token, name: user.name, mobile: m, role: user.role || 'owner', driverId: user.driver_id || '' });
      }

      if (path === '/logout' && req.method === 'POST') {
        if (bearer) await DB.prepare('DELETE FROM sessions WHERE token = ?1').bind(bearer).run();
        return json({ ok: true });
      }

      if (path === '/me') return me ? json(me) : needLogin();

      /* ── Users ── */
      if (path === '/users' && req.method === 'GET') {
        if (!canView) return me ? notAllowed() : needLogin();
        const r = await DB.prepare(
          "SELECT mobile, name, COALESCE(role, 'owner') AS role, driver_id AS driverId FROM users ORDER BY created_at").all();
        return json({ users: r.results || [] });
      }

      if (path === '/users' && req.method === 'POST') {          // create or update a user → new PIN
        if (!isOwner) return me ? notAllowed() : needLogin();
        const m = mobile10(body.mobile), role = ROLES.includes(body.role) ? body.role : 'viewer';
        if (m.length !== 10) return err('Enter a 10-digit mobile number', 400);
        if (m === me.mobile) return err('That’s your own login — use “Change my password”', 400);
        if (role === 'manager' && !body.driverId) return err('Choose which driver record this Driver Manager pays rent for', 400);
        if (role === 'driver') return err('Create driver logins from the Driver Ledger', 400);
        const pin = newPin(), salt = randomHex(16), h = await hashPassword(pin, salt);
        await DB.batch([
          DB.prepare('INSERT INTO users (mobile, name, salt, hash, created_at, role, driver_id, fails, lock_until) ' +
                     'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL) ON CONFLICT(mobile) DO UPDATE SET name = excluded.name, ' +
                     'salt = excluded.salt, hash = excluded.hash, role = excluded.role, driver_id = excluded.driver_id, fails = 0, lock_until = NULL')
            .bind(m, String(body.name || '').slice(0, 60) || 'User', salt, h, now(), role, role === 'manager' ? String(body.driverId) : null),
          DB.prepare('DELETE FROM sessions WHERE mobile = ?1').bind(m),   // old PIN stops working everywhere
        ]);
        return json({ ok: true, pin, mobile: m });
      }

      if (path === '/users/reset-pin' && req.method === 'POST') {
        if (!isOwner) return me ? notAllowed() : needLogin();
        const m = mobile10(body.mobile), user = await getUser(m);
        if (!user) return err('No such user', 404);
        if (m === me.mobile) return err('Use “Change my password” for your own login', 400);
        const pin = newPin(), salt = randomHex(16);
        await DB.batch([
          DB.prepare('UPDATE users SET salt = ?1, hash = ?2, fails = 0, lock_until = NULL WHERE mobile = ?3')
            .bind(salt, await hashPassword(pin, salt), m),
          DB.prepare('DELETE FROM sessions WHERE mobile = ?1').bind(m),
        ]);
        return json({ ok: true, pin, mobile: m });
      }

      if (path === '/users/password' && req.method === 'POST') {  // set my own password
        if (!me) return needLogin();
        const pw = String(body.password || '');
        if (pw.length < 6) return err('Password must be at least 6 characters', 400);
        const salt = randomHex(16);
        await DB.prepare('UPDATE users SET salt = ?1, hash = ?2, name = COALESCE(?3, name) WHERE mobile = ?4')
          .bind(salt, await hashPassword(pw, salt), body.name ? String(body.name).slice(0, 60) : null, me.mobile).run();
        return json({ ok: true });
      }

      if (path === '/users' && req.method === 'DELETE') {
        if (!isOwner) return me ? notAllowed() : needLogin();
        const m = mobile10(url.searchParams.get('mobile'));
        if (m === me.mobile) return err('You can’t remove your own login', 400);
        await DB.batch([DB.prepare('DELETE FROM users WHERE mobile = ?1').bind(m),
                        DB.prepare('DELETE FROM sessions WHERE mobile = ?1').bind(m)]);
        return json({ ok: true });
      }

      /* ── App data ── */
      if (path === '/state' && req.method === 'GET') {
        if (!canView) return me ? notAllowed() : needLogin();
        const r = await row();
        const claims = (await DB.prepare("SELECT * FROM claims WHERE status = 'pending' ORDER BY created_at").all()).results || [];
        return json(r ? { data: JSON.parse(r.data), savedAt: r.saved_at, claims } : { data: null, savedAt: null, claims });
      }
      if (path === '/claims/resolve' && req.method === 'POST') {
        if (!isOwner) return me ? notAllowed() : needLogin();
        const status = body.status === 'accepted' ? 'accepted' : 'rejected';
        const r = await DB.prepare("UPDATE claims SET status = ?1, resolved_at = ?2, resolved_by = ?3 WHERE id = ?4 AND status = 'pending'")
          .bind(status, now(), me.mobile, String(body.id || '')).run();
        return json({ ok: true });
      }
      if (path === '/state' && req.method === 'PUT') {
        if (!isOwner) return me ? notAllowed() : needLogin();
        if (!body.data || !body.savedAt) return err('data and savedAt required', 400);
        const r = await row();
        // Don't let an older copy (e.g. a phone that was offline) overwrite newer data
        if (r && r.saved_at > body.savedAt && !body.force)
          return json({ error: 'conflict', data: JSON.parse(r.data), savedAt: r.saved_at }, 409);
        await DB.prepare('INSERT INTO app_state (id, data, saved_at) VALUES (1, ?1, ?2) ' +
          'ON CONFLICT(id) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at')
          .bind(JSON.stringify(body.data), body.savedAt).run();
        return json({ ok: true, savedAt: body.savedAt });
      }

      /* ── Driver: "I've paid" ── */
      if (path === '/driver/claim' && req.method === 'POST') {
        if (!me) return needLogin();
        if (!isManager || !me.driverId) return notAllowed();
        const amount = Math.round(Number(body.amount) * 100) / 100;
        if (!(amount > 0) || amount > 100000) return err('Enter the amount you paid', 400);
        const waiting = (await DB.prepare("SELECT COUNT(*) AS n FROM claims WHERE driver_id = ?1 AND status = 'pending'").bind(me.driverId).first()).n;
        if (waiting >= 5) return err('You already have 5 payments waiting for the owner to confirm', 400);
        const id = randomHex(8);
        const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.day || '')) ? body.day : null;
        await DB.prepare("INSERT INTO claims (id, driver_id, driver_name, amount, label, status, created_at, day) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)")
          .bind(id, me.driverId, me.name || '', amount, String(body.label || '').slice(0, 80), now(), day).run();
        return json({ ok: true, id });
      }
      if (path === '/driver/claim/cancel' && req.method === 'POST') {
        if (!me) return needLogin();
        if (!isManager) return notAllowed();
        await DB.prepare("UPDATE claims SET status = 'cancelled', resolved_at = ?1 WHERE id = ?2 AND driver_id = ?3 AND status = 'pending'")
          .bind(now(), String(body.id || ''), me.driverId).run();
        return json({ ok: true });
      }

      /* ── Driver Manager view: only his own rent to the owner ── */
      if (path === '/driver' && req.method === 'GET') {
        if (!me) return needLogin();
        if (!isManager || !me.driverId) return notAllowed();
        const r = await row();
        if (!r) return err('Not set up yet', 404);
        const d = JSON.parse(r.data);
        const drv = (d.drivers || []).find(x => x.id === me.driverId);
        if (!drv) return err('Your driver record was removed. Please contact the owner.', 404);
        // His vehicle (multi-vehicle data), falling back to the older single-car format
        const veh = (d.vehicles || []).find(v => v.id === drv.vehicleId) || (d.vehicles || [])[0] || d.car || {};
        const st = d.settings || {};
        return json({
          business: 'MNS Tours & Travels',
          car: { name: veh.name || '', regNo: veh.regNo || '' },
          upi: { id: st.upiId || d.car?.upiId || '', name: st.upiName || d.car?.upiName || 'MNS Tours and Travels' },
          driver: { id: drv.id, name: drv.name, rentCycle: drv.rentCycle, rentAmount: drv.rentAmount,
                    startDate: drv.startDate, endDate: drv.endDate || '' },
          payments: (d.payments || []).filter(p => p.driverId === drv.id).map(p => ({ date: p.date, amount: p.amount, mode: p.mode })),
          offs: (d.offs || []).filter(o => o.driverId === drv.id).map(o => ({ date: o.date, half: o.half })),
          claims: ((await DB.prepare('SELECT id, amount, label, status, created_at AS createdAt, resolved_at AS resolvedAt FROM claims ' +
                    'WHERE driver_id = ?1 ORDER BY created_at DESC LIMIT 20').bind(drv.id).all()).results || []),
          updatedAt: r.saved_at,
        });
      }

      /* ── Driver Ledger ── */
      if (path.startsWith('/ledger')) {
        if (!me) return needLogin();
        // Which ledger drivers may this login see / change?
        const mineSql = isManager ? ' WHERE manager_mobile = ?1 OR manager_mobile IS NULL' : '';
        const myDrivers = async () => {
          if (me.role === 'driver') return ((await DB.prepare('SELECT * FROM ld_drivers WHERE id = ?1').bind(me.driverId || '').all()).results || []);
          if (!canView && !isManager) return [];
          const q = DB.prepare('SELECT * FROM ld_drivers' + mineSql + ' ORDER BY created_at');
          return ((isManager ? await q.bind(me.mobile).all() : await q.all()).results || []);
        };
        const canEdit = isOwner || isManager;
        const ownDriver = async id => (await myDrivers()).find(d => d.id === id);

        if (path === '/ledger' && req.method === 'GET') {
          const drivers = await myDrivers();
          const ids = drivers.map(d => d.id);
          const entries = ids.length ? ((await DB.prepare('SELECT id, driver_id AS driverId, date, kind, platform, amount, note, created_by AS createdBy, created_at AS createdAt ' +
            'FROM ld_entries WHERE deleted = 0 AND driver_id IN (' + ids.map((_, i) => '?' + (i + 1)).join(',') + ') ORDER BY date, created_at')
            .bind(...ids).all()).results || []) : [];
          const r = await row(), st = r ? (JSON.parse(r.data).settings || {}) : {};
          const platforms = Array.isArray(st.platforms) && st.platforms.length ? st.platforms : DEFAULT_PLATFORMS;
          const users = canEdit ? ((await DB.prepare("SELECT mobile, driver_id AS driverId FROM users WHERE role = 'driver'").all()).results || []) : [];
          return json({ role: me.role, platforms,
            drivers: drivers.map(d => ({ id: d.id, name: d.name, mobile: d.mobile || '', rent: d.rent, startDate: d.start_date, endDate: d.end_date || '',
              managerMobile: d.manager_mobile || '', hasLogin: users.some(u => u.driverId === d.id) })),
            entries });
        }
        if (!canEdit) return notAllowed();

        if (path === '/ledger/driver' && req.method === 'POST') {
          const name = String(body.name || '').trim().slice(0, 60), rent = money(body.rent);
          const m = body.mobile ? mobile10(body.mobile) : '';
          if (!name) return err('Enter the driver\u2019s name', 400);
          if (!(rent >= 0) || rent > 100000) return err('Enter the daily rent', 400);
          if (!isYmd(body.startDate)) return err('Enter the start date', 400);
          if (m && m.length !== 10) return err('Enter a 10-digit mobile number', 400);
          const end = isYmd(body.endDate) ? body.endDate : null;
          if (body.id) {
            if (!await ownDriver(body.id)) return notAllowed();
            await DB.prepare('UPDATE ld_drivers SET name = ?1, mobile = ?2, rent = ?3, start_date = ?4, end_date = ?5 WHERE id = ?6')
              .bind(name, m, rent, body.startDate, end, body.id).run();
            return json({ ok: true, id: body.id });
          }
          const id = randomHex(6);
          await DB.prepare('INSERT INTO ld_drivers (id, name, mobile, rent, start_date, end_date, manager_mobile, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
            .bind(id, name, m, rent, body.startDate, end, isManager ? me.mobile : (body.managerMobile ? mobile10(body.managerMobile) : null), now()).run();
          return json({ ok: true, id });
        }

        if (path === '/ledger/entry' && req.method === 'POST') {
          if (!await ownDriver(String(body.driverId || ''))) return notAllowed();
          const kind = KINDS.includes(body.kind) ? body.kind : null, amount = money(body.amount);
          if (!kind) return err('Choose what this entry is', 400);
          if (!isYmd(body.date)) return err('Enter the date', 400);
          if (!(amount > 0) || amount > 100000) return err('Enter the amount', 400);
          const platform = kind === 'credit' ? (String(body.platform || '').trim().slice(0, 30) || 'Other') : null;
          const note = String(body.note || '').slice(0, 120);
          if (body.id) {
            const r = await DB.prepare('UPDATE ld_entries SET date = ?1, kind = ?2, platform = ?3, amount = ?4, note = ?5 WHERE id = ?6 AND driver_id = ?7 AND deleted = 0')
              .bind(body.date, kind, platform, amount, note, String(body.id), String(body.driverId)).run();
            return json({ ok: true, id: body.id });
          }
          const id = randomHex(8);
          await DB.prepare('INSERT INTO ld_entries (id, driver_id, date, kind, platform, amount, note, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
            .bind(id, String(body.driverId), body.date, kind, platform, amount, note, me.name || me.mobile, now()).run();
          return json({ ok: true, id });
        }

        if (path === '/ledger/entry/delete' && req.method === 'POST') {
          const e = await DB.prepare('SELECT driver_id FROM ld_entries WHERE id = ?1').bind(String(body.id || '')).first();
          if (!e || !await ownDriver(e.driver_id)) return notAllowed();
          await DB.prepare('UPDATE ld_entries SET deleted = 1 WHERE id = ?1').bind(String(body.id)).run();
          return json({ ok: true });
        }

        if (path === '/ledger/login' && req.method === 'POST') {     // make / renew a driver's login → PIN
          const d = await ownDriver(String(body.driverId || ''));
          if (!d) return notAllowed();
          const m = mobile10(d.mobile);
          if (m.length !== 10) return err('Add the driver\u2019s 10-digit mobile number first', 400);
          const other = await getUser(m);
          if (other && other.role !== 'driver') return err('This mobile number already has another kind of login', 400);
          const pin = newPin(), salt = randomHex(16), h = await hashPassword(pin, salt);
          await DB.batch([
            DB.prepare("INSERT INTO users (mobile, name, salt, hash, created_at, role, driver_id, fails, lock_until) VALUES (?1, ?2, ?3, ?4, ?5, 'driver', ?6, 0, NULL) " +
                       'ON CONFLICT(mobile) DO UPDATE SET name = excluded.name, salt = excluded.salt, hash = excluded.hash, role = excluded.role, ' +
                       'driver_id = excluded.driver_id, fails = 0, lock_until = NULL').bind(m, d.name, salt, h, now(), d.id),
            DB.prepare('DELETE FROM sessions WHERE mobile = ?1').bind(m),
          ]);
          return json({ ok: true, pin, mobile: m, name: d.name });
        }
        return err('Not found', 404);
      }

      return err('Not found', 404);
    } catch (e) {
      return err(String(e && e.message || e), 500);
    }
  },
};
