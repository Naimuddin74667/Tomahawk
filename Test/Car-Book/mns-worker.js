/* ═══════════════════════════════════════════════════════════════════
   MNS Tours & Travels — Cloudflare Worker (separate account from Tomahawk)

   Needs (Worker → Settings):
     • D1 database binding named  DB
     • Secret named               ADMIN_KEY  (only for the very first login)

   Users — all log in on the same page with mobile number + PIN/password:
     owner   full access (you)
     viewer  sees everything, can't change anything (Uncle)
     driver  sees only his own rent (linked to a driver record)
   The owner creates users; the server generates a 6-digit PIN for each.
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
     GET    /driver                        driver → his own rent only
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
const ROLES = ['owner', 'viewer', 'driver'];

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
  // Columns added over time — add them if this database is older
  for (const col of ["role TEXT DEFAULT 'owner'", 'driver_id TEXT', 'fails INTEGER DEFAULT 0', 'lock_until TEXT']) {
    try { await DB.prepare('ALTER TABLE users ADD COLUMN ' + col).run(); } catch (e) { /* already there */ }
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
        if (role === 'driver' && !body.driverId) return err('Choose which driver this login is for', 400);
        const pin = newPin(), salt = randomHex(16), h = await hashPassword(pin, salt);
        await DB.batch([
          DB.prepare('INSERT INTO users (mobile, name, salt, hash, created_at, role, driver_id, fails, lock_until) ' +
                     'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL) ON CONFLICT(mobile) DO UPDATE SET name = excluded.name, ' +
                     'salt = excluded.salt, hash = excluded.hash, role = excluded.role, driver_id = excluded.driver_id, fails = 0, lock_until = NULL')
            .bind(m, String(body.name || '').slice(0, 60) || 'User', salt, h, now(), role, role === 'driver' ? String(body.driverId) : null),
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
        return json(r ? { data: JSON.parse(r.data), savedAt: r.saved_at } : { data: null, savedAt: null });
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

      /* ── Driver view: only his own rent ── */
      if (path === '/driver' && req.method === 'GET') {
        if (!me) return needLogin();
        if (me.role !== 'driver' || !me.driverId) return notAllowed();
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
          updatedAt: r.saved_at,
        });
      }

      return err('Not found', 404);
    } catch (e) {
      return err(String(e && e.message || e), 500);
    }
  },
};
