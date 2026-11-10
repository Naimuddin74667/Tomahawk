/* =========================================================
   Royal Enterprises — Cloudflare Worker (backend)
   Account: naimuddinshaikh74667 · Worker name: royal-enterprises
   Deploy: paste this whole file in Cloudflare → Workers → royal-enterprises → Edit code → Deploy
   (NOT part of the Tomahawk auto-deploy — that only watches the repo-root worker.js)

   Bindings / secrets needed (Settings → Bindings / Variables and Secrets):
     DB              D1 database binding  (database: royal-enterprises-db)
     GEMINI_API_KEY  secret — key from aistudio.google.com/apikey
     OWNER_KEY       secret — any password you choose; the owner types it once in the app

   Endpoints (all via ?action=...):
     GET  ping           → { ok, gemini, db }        health check, no key needed
     GET  getAll         → { state, updated }        full catalogue/stock/orders JSON   [owner key]
     POST saveAll        { state }                   [owner key]
     GET  photo&id=      → image bytes               public, cached (shop screens use it)
     POST savePhoto      { data: dataURL }  → { id, url }      [owner key]
     POST analyzePhoto   { image: base64 JPEG }  → { corners, box, brand, model, ... }  [owner key]
     POST studioPhoto    { image: base64 JPEG }  → Gemini image response (studio packshot of the box)  [owner key]
     POST listSource     { src: 'sarju'|'ticon' } → { items }   whole brand-website catalogue, cleaned  [owner key]
     POST importPhoto    { url }  → { id, url }      copy a brand-website photo into D1  [owner key]
     POST sourceImages   { src, id } → { images }   ALL photos of one brand-website product (gallery + variations + description)  [owner key]
   Shops (owner key):
     POST shopsList / shopSave {shop} / shopToggle {id,active} / shopResetLink {id}
     POST ordersList {} / orderSetStatus {id,status}
   Shopkeeper (private link token → session in X-Shop-Session header):
     GET  shopInfo&s=TOKEN          → { name }            for the login screen
     POST shopLogin {token,mobile}  → { sess, shop }      5 wrong tries = 15 min lock
     GET  shopCatalog               → catalogue WITHOUT purchase prices
     POST shopPlaceOrder {items,note} → { no, total }     prices taken from the server copy
     GET  shopMyOrders              → this shop's orders
   ========================================================= */

// Tried in order. A model that is busy, over quota, retired or unknown is skipped and the next one is used.
// Each model has its own free quota, so a busy spell on one rarely blocks all of them.
// Override/prepend with a GEMINI_MODEL variable in Cloudflare if needed.
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.8-flash-lite'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Owner-Key,X-Shop-Session'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Tables are created on first request — no manual SQL needed
async function ensureTables(env) {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS app_state (k TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS shops (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT, mobile TEXT NOT NULL UNIQUE, area TEXT, address TEXT, map TEXT, credit_limit REAL, token TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, last_order INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS shop_sessions (sess TEXT PRIMARY KEY, shop_id TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS login_fails (token TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS shop_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id TEXT NOT NULL, json TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, updated INTEGER)')
  ]);
}

function isOwner(req, env) {
  const k = req.headers.get('X-Owner-Key') || '';
  return env.OWNER_KEY && k === env.OWNER_KEY;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'ping';
    try {
      if (action === 'ping') {
        return json({ ok: true, gemini: !!env.GEMINI_API_KEY, db: !!env.DB, ownerKeySet: !!env.OWNER_KEY });
      }
      if (!env.DB) return json({ error: 'D1 binding "DB" missing' }, 500);
      await ensureTables(env);

      // ---------- shopkeeper routes (link token / session) ----------
      if (action === 'shopInfo') {
        const sh = await env.DB.prepare('SELECT name FROM shops WHERE token = ? AND active = 1').bind(url.searchParams.get('s') || '').first();
        return sh ? json({ name: sh.name }) : json({ error: 'This link is not active. Ask Royal Enterprises for a new link.' }, 404);
      }
      if (action === 'shopLogin') {
        if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
        const b = await req.json();
        return shopLogin(env, String(b.token || ''), String(b.mobile || ''));
      }
      if (action === 'shopCatalog' || action === 'shopPlaceOrder' || action === 'shopMyOrders') {
        const shop = await shopFromSession(req, env);
        if (!shop) return json({ error: 'Please log in again with your shop link' }, 401);
        if (action === 'shopCatalog') return json(await shopCatalog(env));
        if (action === 'shopMyOrders') {
          const rs = await env.DB.prepare('SELECT id, json, status, ts FROM shop_orders WHERE shop_id = ? ORDER BY id DESC LIMIT 50').bind(shop.id).all();
          return json({ orders: rs.results.map(orderOut) });
        }
        if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
        return shopPlaceOrder(env, shop, await req.json());
      }

      if (action === 'getAll') {
        if (!isOwner(req, env)) return json({ error: 'Owner key wrong or missing' }, 401);
        const row = await env.DB.prepare('SELECT json, updated FROM app_state WHERE k = ?').bind('main').first();
        return json({ state: row ? JSON.parse(row.json) : null, updated: row ? row.updated : 0 });
      }

      if (action === 'photo') {
        const id = url.searchParams.get('id') || '';
        const row = await env.DB.prepare('SELECT mime, data FROM photos WHERE id = ?').bind(id).first();
        if (!row) return new Response('not found', { status: 404, headers: CORS });
        const bytes = Uint8Array.from(atob(row.data), c => c.charCodeAt(0));
        // photos never change (new photo = new id), so let phones cache them for a year
        return new Response(bytes, { headers: { ...CORS, 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=31536000, immutable' } });
      }

      // ---- everything below changes data or costs Gemini quota → owner key required ----
      if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
      if (!isOwner(req, env)) return json({ error: 'Owner key wrong or missing' }, 401);
      const body = await req.json();

      if (action === 'saveAll') {
        if (!body.state) return json({ error: 'state missing' }, 400);
        const now = Date.now();
        await env.DB.prepare('INSERT INTO app_state (k, json, updated) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET json = excluded.json, updated = excluded.updated')
          .bind('main', JSON.stringify(body.state), now).run();
        return json({ ok: true, updated: now });
      }

      if (action === 'savePhoto') {
        const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(body.data || '');
        if (!m) return json({ error: 'data must be a JPEG/PNG/WebP data URL' }, 400);
        if (m[2].length > 1_400_000) return json({ error: 'photo too large (max ~1 MB)' }, 413);
        const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        await env.DB.prepare('INSERT INTO photos (id, mime, data, created) VALUES (?, ?, ?, ?)').bind(id, m[1], m[2], Date.now()).run();
        return json({ id, url: `${url.origin}/?action=photo&id=${id}` });
      }

      if (action === 'sourceImages') return json({ images: await sourceImages(env, body.src || 'sarju', parseInt(body.id)) });
      if (action === 'listSource' || action === 'listSarju') return json({ items: await listSource(env, body.src || 'sarju') });

      // ---------- shops & shop orders (owner) ----------
      if (action === 'shopsList') {
        const rs = await env.DB.prepare('SELECT * FROM shops ORDER BY id').all();
        return json({ shops: rs.results });
      }
      if (action === 'shopSave') return shopSave(env, body.shop || {});
      if (action === 'shopToggle') {
        await env.DB.prepare('UPDATE shops SET active = ? WHERE id = ?').bind(body.active ? 1 : 0, String(body.id)).run();
        if (!body.active) await env.DB.prepare('DELETE FROM shop_sessions WHERE shop_id = ?').bind(String(body.id)).run();
        return json({ ok: true });
      }
      if (action === 'shopResetLink') {
        const token = randomId(10);
        await env.DB.batch([
          env.DB.prepare('UPDATE shops SET token = ? WHERE id = ?').bind(token, String(body.id)),
          env.DB.prepare('DELETE FROM shop_sessions WHERE shop_id = ?').bind(String(body.id))   // logs out the old phone
        ]);
        return json({ ok: true, token });
      }
      if (action === 'ordersList') {
        const rs = await env.DB.prepare('SELECT id, shop_id, json, status, ts FROM shop_orders ORDER BY id DESC LIMIT 300').all();
        return json({ orders: rs.results.map(orderOut) });
      }
      if (action === 'orderSetStatus') {
        const id = parseInt(String(body.id).replace(/\D/g, ''));
        if (!['new', 'confirmed', 'cancelled', 'delivered'].includes(body.status)) return json({ error: 'bad status' }, 400);
        await env.DB.prepare('UPDATE shop_orders SET status = ?, updated = ? WHERE id = ?').bind(body.status, Date.now(), id).run();
        return json({ ok: true });
      }

      if (action === 'importPhoto') {
        let u; try { u = new URL(body.url); } catch (e) { return json({ error: 'bad url' }, 400); }
        const hosts = Object.keys(SOURCES).map(k => new URL(sourceBase(env, k)).host);
        if (!hosts.includes(u.host)) return json({ error: 'only ' + hosts.join(' / ') + ' photos can be imported' }, 400);
        const r = await fetch(u.toString());
        const mime = (r.headers.get('content-type') || '').split(';')[0];
        if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(mime)) return json({ error: 'not a photo (' + r.status + ' ' + mime + ')' }, 400);
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length > 1_000_000) return json({ error: 'photo too large' }, 413);
        let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        await env.DB.prepare('INSERT INTO photos (id, mime, data, created) VALUES (?, ?, ?, ?)').bind(id, mime, btoa(bin), Date.now()).run();
        return json({ id, url: `${url.origin}/?action=photo&id=${id}` });
      }

      if (action === 'studioPhoto') {
        if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY secret not set' }, 500);
        if (!body.image) return json({ error: 'image missing' }, 400);
        return studioWithGemini(env, body.image);
      }

      if (action === 'analyzePhoto') {
        if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY secret not set' }, 500);
        if (!body.image) return json({ error: 'image missing' }, 400);
        return json(await analyzeWithGemini(env, body.image));
      }

      return json({ error: 'unknown action ' + action }, 400);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
};

/* ---------- Gemini: find the product box + read what's printed on it ---------- */
const PROMPT = `This is a phone photo of a mobile-accessory product box (cable, charger, earphones, power bank, cover, tempered glass...) lying on a cluttered table.
Return ONLY JSON with these fields:
- "corners": the 4 corners of the FRONT FACE of the main product box as [[x,y],[x,y],[x,y],[x,y]] in order top-left, top-right, bottom-right, bottom-left, each value normalised 0-1000 (x across the width, y down the height). Follow the real box edges even if the box is tilted.
- "box_2d": [ymin, xmin, ymax, xmax] of the same box, normalised 0-1000.
- "brand": brand printed on the box (e.g. "Sarju", "Ticon"), or "".
- "model": model code printed on the box (e.g. "C48"), or "".
- "product_name": a SHORT sellable name built ONLY from the box text, ALWAYS in this order: "<MODEL without hyphen> - <WATTS>W <AMPS>A <CONNECTOR> <2-4 key words> <product type>". Leave out any part that is not printed. CONNECTOR is "Type-C", "Micro", "Lightning" or "Type-C to Type-C". Title Case, no brand, max 60 characters. Do NOT put length, connector ends like "USB-A to" or features in the name — those go in "description". e.g. "FC195 - 65W 4.1A Type-C Pure Silicone Data Cable", "TT46 - 65W 5A Type-C to Type-C Cable", "FC266 - 25W Micro Ultra Soft Silicone Cable".
- "name_options": 2 more good alternative names in the same style (array of strings).
- "description": EVERY other detail printed on the box, as short points joined with " · ", in this order when present: wattage, current (e.g. 5A), length (convert 1000 MM to "1 m"), connector ends (e.g. "USB-A to Type-C", "Type-C to Type-C", "USB-A to Micro USB"), material/body (e.g. "Alloy braided", "Ultra soft silicone"), colour, then every printed feature (e.g. "Intelligent chip", "Fast charging", "Data transmission", "Flexible body", "Safe and fast"). Plain words only, no brand, no slogans like "100% original". e.g. "100W · 1 m · USB-A to Type-C · Alloy braided · Intelligent chip · Fast charging · Flexible body · Safe and fast".
- "variant": the connector at the phone end, exactly one of "Type-C", "Micro USB", "Lightning" (a Type-C to Type-C cable is "Type-C"); for non-cables the colour or type printed (e.g. "Black"), or "".
- "category": one of "Cables","Chargers","Earphones","Power Banks","Covers","Tempered Glass","Other".
- "watts": wattage printed (e.g. "65W"), or "".
- "amps": current printed (e.g. "4.1A"), or "".
If there is no product box, return {"corners":null,"box_2d":null}.`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// busy / over quota / temporary server trouble → worth retrying or moving to the next model
const isTransient = (status, msg) => [429, 500, 502, 503, 504].includes(status) || /high demand|overloaded|unavailable|resource.?exhausted|quota|try again/i.test(msg);
const isGone = (status, msg) => status === 404 || /no longer available|not found|not supported for generatecontent|is not supported/i.test(msg);

async function analyzeWithGemini(env, base64Jpeg) {
  const models = [...new Set(env.GEMINI_MODEL ? [env.GEMINI_MODEL, ...GEMINI_MODELS] : GEMINI_MODELS)];
  const body = { contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: base64Jpeg } }, { text: PROMPT }] }],
    // no temperature (not allowed on Gemini 3.8+); low thinking = fast answer, plenty for box + label reading
    generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } } };
  const readJson = async r => { const t = await r.text(); try { return JSON.parse(t); } catch (e) { return { error: { message: 'HTTP ' + r.status + ' ' + t.slice(0, 80) } }; } };
  let res, data, lastMsg = '';
  outer: for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let b = body;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          signal: AbortSignal.timeout(40000), body: JSON.stringify(b) });
      } catch (e) { lastMsg = e.name === 'TimeoutError' ? 'took too long' : e.message; continue; }
      data = await readJson(res);
      let msg = (data.error && data.error.message) || '';
      if (res.status === 400 && /thinking/i.test(msg)) {          // model without thinking settings → plain request
        b = { ...body, generationConfig: { responseMimeType: 'application/json' } };
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(b) });
        data = await readJson(res); msg = (data.error && data.error.message) || '';
      }
      if (res.ok) break outer;
      lastMsg = msg || ('HTTP ' + res.status);
      // Cloudflare ran this Worker from a data centre Google blocks (e.g. Hong Kong) → the owner's phone (India)
      // makes the call itself, with the same model list and retry rules. Key is handed over for this call only.
      if (/location is not supported/i.test(msg)) return { clientCall: { models, body }, key: env.GEMINI_API_KEY };
      if (isGone(res.status, msg)) continue outer;                 // retired / unknown → next model
      if (isTransient(res.status, msg)) { if (attempt === 0) { await sleep(1500); continue; } continue outer; }
      break outer;                                                 // real error (bad key etc.) → stop
    }
  }
  if (!res || !res.ok) throw new Error('Gemini busy — ' + lastMsg);
  const text = data.candidates && data.candidates[0] && data.candidates[0].content.parts.map(p => p.text || '').join('') || '{}';
  let out;
  try { out = JSON.parse(text); } catch (e) { throw new Error('Gemini returned non-JSON'); }
  // sanity-check corners: 4 points, all inside 0..1000
  const ok = Array.isArray(out.corners) && out.corners.length === 4 && out.corners.every(p => Array.isArray(p) && p.length === 2 && p.every(v => v >= 0 && v <= 1000));
  if (!ok) out.corners = null;
  return out;
}

/* ---------- Brand websites (both run WooCommerce → public Store API) ---------- */
const SOURCES = { sarju: { base: 'https://sarjuworld.com', brand: 'Sarju' }, ticon: { base: 'https://ticon.in', brand: 'Ticon' } };
const sourceBase = (env, k) => env[k.toUpperCase() + '_BASE'] || SOURCES[k].base;   // e.g. SARJU_BASE override for testing
const decode = t => String(t || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const strip = h => decode(String(h || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
// specs table rows <tr><td>Key</td><td>Value</td></tr> → { Key: Value }
function parseSpecs(html) {
  const out = {};
  for (const li of String(html || '').match(/<li[^>]*>[\s\S]*?<\/li>/gi) || []) {
    const t = strip(li), m = t.match(/^([A-Za-z][\w /&()-]{1,30}?)\s*:\s*(.{1,120})$/);
    if (m && !out[m[1].trim()]) out[m[1].trim()] = m[2].trim();
  }
  for (const row of String(html || '').match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(strip);
    if (cells.length >= 2 && cells[0] && cells[1] && !/^feature$/i.test(cells[0])) out[cells[0]] = cells[1];
  }
  return out;
}
// medium-size photo (~600–800 px) from the srcset, else the full one
function pickImg(img) {
  const set = String(img.srcset || '').split(',').map(x => x.trim().split(/\s+/)).filter(x => x[0]).map(([u, w]) => [u, parseInt(w) || 0]);
  const good = set.filter(x => x[1] >= 600).sort((a, b) => a[1] - b[1])[0];
  return good ? good[0] : img.src;
}
// "C90 SUPER FAST CABLE" → "C90 Super Fast Cable" (model codes and USB/TWS-style words stay capitals)
const KEEP_CAPS = /^(USB|TWS|LED|BT|PD|AUX|OTG|HD|LCD|ANC|ENC|RGB|QC|FM|TF|SD|PC|IOS)$/;
function tidyName(n) {
  if (n !== n.toUpperCase()) return n;
  const cap = w => /\d/.test(w) || KEEP_CAPS.test(w) || w.length === 1 ? w : w.charAt(0) + w.slice(1).toLowerCase();
  return n.split(/\s+/).map(w => /^(TO|AND|FOR|WITH|OF)$/.test(w) ? w.toLowerCase() : w.split('-').map(cap).join('-')).join(' ');
}
// Every photo of a brand-website product: its gallery + each variation's photo (Type-C / Micro…) + photos inside the description.
// Same file from different sizes (-600x600, -scaled) counts once. Only photos on the brand's own site are kept.
function galleryFrom(base, p, variations) {
  const host = new URL(base).host.replace(/^www\./, ''), seen = new Set(), out = [];
  const norm = u => {
    try {
      let x = new URL(u, base);
      if (/^i\d\.wp\.com$/.test(x.host)) x = new URL('https://' + x.pathname.slice(1));   // Jetpack CDN copy → original
      x.search = '';
      return x.host.replace(/^www\./, '') === host && /\.(jpe?g|png|webp)$/i.test(x.pathname) ? x.toString() : '';
    } catch (e) { return ''; }
  };
  const add = u => {
    u = norm(u); if (!u) return;
    const k = new URL(u).pathname.replace(/-\d+x\d+(?=\.\w+$)/, '').replace(/-scaled(?=\.\w+$)/, '').toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(u); }
  };
  (p.images || []).forEach(im => add(pickImg(im)));
  (variations || []).forEach(v => (v.images || []).forEach(im => add(pickImg(im))));
  for (const tag of String(p.description || '').match(/<img[^>]+>/gi) || []) {
    if (/logo|icon|badge|whatsapp|payment/i.test(tag)) continue;
    for (const m of tag.matchAll(/(?:data-lazy-src|data-src|src)=["']([^"']+)["']/gi)) if (!/-(?:\d{1,2}|1[0-4]\d)x\d+\./.test(m[1])) add(m[1]);
  }
  return out.slice(0, 12);
}
async function sourceImages(env, src, id) {
  if (!SOURCES[src]) throw new Error('unknown source ' + src);
  const base = sourceBase(env, src);
  const get = async pid => { const r = await fetch(`${base}/wp-json/wc/store/v1/products/${pid}`, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error(SOURCES[src].brand + ' site: HTTP ' + r.status); return r.json(); };
  const p = await get(id);
  const variations = await Promise.all((p.variations || []).slice(0, 8).map(v => get(v.id).catch(() => null)));
  return galleryFrom(base, p, variations.filter(Boolean));
}
async function listSource(env, src) {
  if (!SOURCES[src]) throw new Error('unknown source ' + src);
  const base = sourceBase(env, src), items = [];
  for (let page = 1, pages = 1; page <= pages && page <= 20; page++) {
    const r = await fetch(`${base}/wp-json/wc/store/v1/products?per_page=100&page=${page}`, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(SOURCES[src].brand + ' site: HTTP ' + r.status);
    pages = parseInt(r.headers.get('X-WP-TotalPages') || '1') || 1;
    for (const p of await r.json()) {
      const name = tidyName(decode(p.name).replace(/^\s*(sarju|ticon)\b\s*[–—-]?\s*/i, '').trim());
      const specs = parseSpecs(p.short_description + (p.description || ''));
      const model = ((specs['Model Number'] || specs['Model'] || specs['Model No'] || '') + ' ' + name).match(/\b([A-Z]{1,4}-?\d{1,5}[A-Z]?)\b/i);
      items.push({
        src, id: p.id, name, url: p.permalink,
        model: model ? model[1].toUpperCase() : '',
        cats: (p.categories || []).map(c => decode(c.name)).filter(c => !/^(popular|uncategori[sz]ed|new arrivals?|best sellers?|featured)$/i.test(c)),
        specs,
        thumb: (p.images && p.images[0] && (p.images[0].thumbnail || p.images[0].src)) || '',
        images: (p.images || []).slice(0, 10).map(pickImg)
      });
    }
  }
  return items;
}

/* ---------- shops: login, catalogue for shops, orders ---------- */
function randomId(n) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, x => abc[x % abc.length]).join('');
}
const cleanMobile = m => String(m || '').replace(/\D/g, '').slice(-10);
const orderNo = id => 'SO-' + String(id).padStart(4, '0');
function orderOut(r) { const o = JSON.parse(r.json); return { ...o, id: 'so' + r.id, no: orderNo(r.id), status: r.status, ts: r.ts, shopId: r.shop_id || o.shopId }; }

async function shopSave(env, sh) {
  const name = String(sh.name || '').trim(), mobile = cleanMobile(sh.mobile);
  if (!name) return json({ error: 'Shop name is required' }, 400);
  if (mobile.length !== 10) return json({ error: 'Enter a 10-digit mobile number' }, 400);
  const dup = await env.DB.prepare('SELECT id, name FROM shops WHERE mobile = ? AND id != ?').bind(mobile, String(sh.id || '')).first();
  if (dup) return json({ error: `This mobile is already used by ${dup.name} (${dup.id})` }, 409);
  const f = [name, String(sh.owner || '').trim(), mobile, String(sh.area || '').trim(), String(sh.address || '').trim(), String(sh.map || '').trim(), sh.credit_limit === '' || sh.credit_limit == null ? null : Number(sh.credit_limit) || 0];
  if (sh.id) {
    await env.DB.prepare('UPDATE shops SET name=?, owner=?, mobile=?, area=?, address=?, map=?, credit_limit=? WHERE id=?').bind(...f, String(sh.id)).run();
    return json({ shop: await env.DB.prepare('SELECT * FROM shops WHERE id = ?').bind(String(sh.id)).first() });
  }
  const last = await env.DB.prepare("SELECT id FROM shops ORDER BY CAST(SUBSTR(id, 4) AS INTEGER) DESC LIMIT 1").first();
  const id = 'SH-' + String((last ? parseInt(last.id.slice(3)) : 0) + 1).padStart(4, '0');
  await env.DB.prepare('INSERT INTO shops (id, name, owner, mobile, area, address, map, credit_limit, token, active, created) VALUES (?,?,?,?,?,?,?,?,?,1,?)').bind(id, ...f, randomId(10), Date.now()).run();
  return json({ shop: await env.DB.prepare('SELECT * FROM shops WHERE id = ?').bind(id).first() });
}

async function shopLogin(env, token, mobile) {
  const now = Date.now();
  const fail = await env.DB.prepare('SELECT count, until FROM login_fails WHERE token = ?').bind(token).first();
  if (fail && fail.until && fail.until > now) return json({ error: `Too many wrong tries. Try again in ${Math.ceil((fail.until - now) / 60000)} min.` }, 429);
  const sh = await env.DB.prepare('SELECT * FROM shops WHERE token = ? AND active = 1').bind(token).first();
  if (!sh) return json({ error: 'This link is not active. Ask Royal Enterprises for a new link.' }, 404);
  if (cleanMobile(mobile) !== sh.mobile) {
    const count = (fail && (!fail.until || fail.until <= now) ? fail.count : 0) + 1;
    const until = count >= 5 ? now + 15 * 60000 : null;
    await env.DB.prepare('INSERT INTO login_fails (token, count, until) VALUES (?,?,?) ON CONFLICT(token) DO UPDATE SET count = excluded.count, until = excluded.until').bind(token, until ? 0 : count, until).run();
    return json({ error: until ? 'Too many wrong tries. Try again in 15 min.' : `Number does not match this shop. ${5 - count} tries left.` }, 401);
  }
  await env.DB.prepare('DELETE FROM login_fails WHERE token = ?').bind(token).run();
  const sess = randomId(32);
  await env.DB.prepare('INSERT INTO shop_sessions (sess, shop_id, created, last_seen) VALUES (?,?,?,?)').bind(sess, sh.id, now, now).run();
  return json({ sess, shop: { id: sh.id, name: sh.name, owner: sh.owner, area: sh.area } });
}

async function shopFromSession(req, env) {
  const sess = req.headers.get('X-Shop-Session') || '';
  if (!sess) return null;
  const sh = await env.DB.prepare('SELECT s.* FROM shop_sessions x JOIN shops s ON s.id = x.shop_id WHERE x.sess = ? AND s.active = 1').bind(sess).first();
  if (sh) await env.DB.prepare('UPDATE shop_sessions SET last_seen = ? WHERE sess = ?').bind(Date.now(), sess).run();
  return sh;
}

// What a shop may see: no purchase price, stock capped (shows "in stock / only N left")
async function shopCatalog(env) {
  const row = await env.DB.prepare('SELECT json, updated FROM app_state WHERE k = ?').bind('main').first();
  const S = row ? JSON.parse(row.json) : { brands: [], cats: [], products: [] };
  const products = (S.products || []).map(p => ({
    id: p.id, name: p.name, brandId: p.brandId, catId: p.catId, desc: p.desc || '', photo: p.photo || '', photos: p.photos || [],
    variants: (p.variants || []).map(v => ({ id: v.id, label: v.label, sku: v.sku, dist: Number(v.dist) || 0, retail: Number(v.retail) || 0,
      stock: Math.max(0, Math.min(Number(v.stock) || 0, 9999)), lowAt: Number(v.lowAt) || 0, box: Math.max(1, Math.round(Number(v.box)) || 1), photo: v.photo || '' }))
  }));
  return { state: { brands: S.brands || [], cats: S.cats || [], products, log: [], orders: [], meta: {} }, updated: row ? row.updated : 0 };
}

async function shopPlaceOrder(env, shop, body) {
  const row = await env.DB.prepare('SELECT json FROM app_state WHERE k = ?').bind('main').first();
  const S = row ? JSON.parse(row.json) : { products: [] };
  const byV = {}; (S.products || []).forEach(p => (p.variants || []).forEach(v => { byV[v.id] = { p, v }; }));
  const items = [];
  for (const it of (body.items || []).slice(0, 200)) {
    const f = byV[it.vid], qty = Math.round(Number(it.qty) || 0);
    if (!f || qty <= 0 || qty > 99999 || !(Number(f.v.dist) > 0)) continue;
    const box = Math.max(1, Math.round(Number(f.v.box)) || 1);
    if (qty % box) return json({ error: `${f.p.name} ${f.v.label} is sold in boxes of ${box} — refresh and try again` }, 400);
    items.push({ pid: f.p.id, vid: f.v.id, name: f.p.name, label: f.v.label, sku: f.v.sku, qty, box, rate: Number(f.v.dist) });   // server price, not the phone's
  }
  if (!items.length) return json({ error: 'No valid items in the order (rates may have changed — refresh)' }, 400);
  const o = { shopId: shop.id, shopName: shop.name, source: 'shop', items, total: items.reduce((a, x) => a + x.qty * x.rate, 0), note: String(body.note || '').slice(0, 300) };
  const now = Date.now();
  const r = await env.DB.prepare('INSERT INTO shop_orders (shop_id, json, status, ts) VALUES (?, ?, ?, ?) RETURNING id').bind(shop.id, JSON.stringify(o), 'new', now).first();
  await env.DB.prepare('UPDATE shops SET last_order = ? WHERE id = ?').bind(now, shop.id).run();
  return json({ id: 'so' + r.id, no: orderNo(r.id), total: o.total });
}

/* ---------- Gemini image model: phone photo → clean e-commerce packshot of the SAME box ---------- */
const IMAGE_MODELS = ['gemini-nano-banana-2.1', 'gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image'];
const STUDIO_PROMPT = `Turn this phone photo into a professional e-commerce product packshot of the SAME retail box.
STRICT RULES — the box must stay exactly as it is:
- same shape, proportions, colours, logo, product artwork and every printed word and number (brand, model code, wattage, connector type) — unchanged, sharp and readable;
- do not redraw, translate, add or remove any text or graphics; do not open the box; do not show the product outside the box.
Fix only the photography:
- remove the background, table, hands and anything else around the box;
- straighten the box so it faces the camera front-on and upright;
- remove glare, reflections and room shadows; even, bright studio lighting; true colours; crisp focus.
Output: square 1:1 image, pure white background (#FFFFFF), box centred, filling about 85% of the height, with a soft natural shadow under it. No props, no extra text, no watermark, no border.`;

async function studioWithGemini(env, base64Jpeg) {
  const models = [...new Set(env.GEMINI_IMAGE_MODEL ? [env.GEMINI_IMAGE_MODEL, ...IMAGE_MODELS] : IMAGE_MODELS)];
  const body = { contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: base64Jpeg } }, { text: STUDIO_PROMPT }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } } };
  let lastMsg = '';
  outer: for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let b = body, res;
      const send = bb => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        signal: AbortSignal.timeout(75000), body: JSON.stringify(bb) });
      try { res = await send(b); } catch (e) { lastMsg = e.name === 'TimeoutError' ? 'took too long' : e.message; continue; }
      // success → pass Google's answer straight through (no parsing here: the image is big and Workers have little CPU time)
      if (res.ok) return new Response(res.body, { headers: { ...CORS, 'Content-Type': 'application/json', 'X-Model': model } });
      let msg = ''; try { msg = ((await res.json()).error || {}).message || ''; } catch (e) {}
      if (res.status === 400 && /imageConfig|aspect/i.test(msg)) {          // model without aspect-ratio setting → plain request
        b = { ...body, generationConfig: { responseModalities: ['IMAGE'] } };
        res = await send(b);
        if (res.ok) return new Response(res.body, { headers: { ...CORS, 'Content-Type': 'application/json', 'X-Model': model } });
        try { msg = ((await res.json()).error || {}).message || ''; } catch (e) {}
      }
      lastMsg = msg || ('HTTP ' + res.status);
      if (/location is not supported/i.test(msg)) return json({ clientCall: { models, body }, key: env.GEMINI_API_KEY });
      if (/limit:\s*0|free tier|billing|paid tier/i.test(msg)) return json({ error: 'Image generation is not included in the free Gemini key. Turn on billing for this key in Google AI Studio to use it.', billing: true }, 402);
      if (isGone(res.status, msg)) continue outer;
      if (isTransient(res.status, msg)) { if (attempt === 0) { await sleep(2000); continue; } continue outer; }
      break outer;
    }
  }
  return json({ error: 'Image generation failed — ' + lastMsg }, 502);
}
