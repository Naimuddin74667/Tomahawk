/* ═══════════════════════════════════════════════════════════════════
   MNS Tours & Travels — Cloudflare Worker (separate account from Tomahawk)

   Needs, in the Cloudflare dashboard (Worker → Settings):
     • D1 database binding named  DB
     • Secret named               ADMIN_KEY   (your own password for the owner app)

   Endpoints
     GET  /state            owner only  → whole app data
     PUT  /state            owner only  → save whole app data (refuses older copies)
     GET  /driver?code=XYZ  driver      → that driver's rent, payments and car-off days only
     GET  /                 health check
   ═══════════════════════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.DB) return json({ error: 'D1 binding "DB" is missing' }, 500);

    // One row holds the whole app data as JSON (simple, and plenty for one car)
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL, saved_at TEXT NOT NULL)'
    ).run();

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const isOwner = !!env.ADMIN_KEY && req.headers.get('X-Admin-Key') === env.ADMIN_KEY;
    const row = () => env.DB.prepare('SELECT data, saved_at FROM app_state WHERE id = 1').first();

    try {
      if (path === '/') return json({ ok: true, app: 'MNS Tours & Travels' });

      if (path === '/state') {
        if (!isOwner) return json({ error: 'Wrong or missing key' }, 401);

        if (req.method === 'GET') {
          const r = await row();
          return json(r ? { data: JSON.parse(r.data), savedAt: r.saved_at } : { data: null, savedAt: null });
        }

        if (req.method === 'PUT') {
          const body = await req.json();
          if (!body || !body.data || !body.savedAt) return json({ error: 'data and savedAt required' }, 400);
          const r = await row();
          // Don't let an older copy (e.g. a phone that was offline) overwrite newer data
          if (r && r.saved_at > body.savedAt && !body.force) {
            return json({ error: 'conflict', data: JSON.parse(r.data), savedAt: r.saved_at }, 409);
          }
          await env.DB.prepare(
            'INSERT INTO app_state (id, data, saved_at) VALUES (1, ?1, ?2) ' +
            'ON CONFLICT(id) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at'
          ).bind(JSON.stringify(body.data), body.savedAt).run();
          return json({ ok: true, savedAt: body.savedAt });
        }
        return json({ error: 'Method not allowed' }, 405);
      }

      if (path === '/driver' && req.method === 'GET') {
        const code = (url.searchParams.get('code') || '').trim();
        if (code.length < 6) return json({ error: 'Invalid link' }, 400);
        const r = await row();
        if (!r) return json({ error: 'Not set up yet' }, 404);
        const d = JSON.parse(r.data);
        const drv = (d.drivers || []).find(x => x.accessCode === code);
        if (!drv) return json({ error: 'This link is no longer active' }, 404);
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
