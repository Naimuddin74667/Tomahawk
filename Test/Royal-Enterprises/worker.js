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
     GET  getAll         → { state, updated }        catalogue/stock/orders JSON
     POST saveAll        { state }                   [owner key]
     GET  photo&id=      → image bytes               public, cached (shop screens use it)
     POST savePhoto      { data: dataURL }  → { id, url }      [owner key]
     POST analyzePhoto   { image: base64 JPEG }  → { corners, box, brand, model, ... }  [owner key]
     POST listSarju      {}  → { items: [...] }      whole sarjuworld.com catalogue, cleaned  [owner key]
     POST importPhoto    { url }  → { id, url }      copy a sarjuworld.com photo into D1  [owner key]
   ========================================================= */

const GEMINI_MODEL = 'gemini-2.5-flash';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Owner-Key'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Tables are created on first request — no manual SQL needed
async function ensureTables(env) {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS app_state (k TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL)')
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

      if (action === 'getAll') {
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

      if (action === 'listSarju') return json({ items: await listSarju(env) });

      if (action === 'importPhoto') {
        const base = new URL(env.SARJU_BASE || SARJU_BASE);
        let u; try { u = new URL(body.url); } catch (e) { return json({ error: 'bad url' }, 400); }
        if (u.host !== base.host) return json({ error: 'only ' + base.host + ' photos can be imported' }, 400);
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
- "product_name": short sellable name built from the box text, e.g. "C48 Metal Anti-Bending Data Cable 65W".
- "variant": the connector/type/colour this box is for (e.g. "Type-C", "Micro USB", "Lightning", "Black"), or "".
- "category": one of "Cables","Chargers","Earphones","Power Banks","Covers","Tempered Glass","Other".
- "watts": wattage printed (e.g. "65W"), or "".
If there is no product box, return {"corners":null,"box_2d":null}.`;

async function analyzeWithGemini(env, base64Jpeg) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: base64Jpeg } }, { text: PROMPT }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Gemini: ' + (data.error && data.error.message || res.status));
  const text = data.candidates && data.candidates[0] && data.candidates[0].content.parts.map(p => p.text || '').join('') || '{}';
  let out;
  try { out = JSON.parse(text); } catch (e) { throw new Error('Gemini returned non-JSON'); }
  // sanity-check corners: 4 points, all inside 0..1000
  const ok = Array.isArray(out.corners) && out.corners.length === 4 && out.corners.every(p => Array.isArray(p) && p.length === 2 && p.every(v => v >= 0 && v <= 1000));
  if (!ok) out.corners = null;
  return out;
}

/* ---------- Sarju website catalogue (WooCommerce Store API, public) ---------- */
const SARJU_BASE = 'https://sarjuworld.com';
const decode = t => String(t || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const strip = h => decode(String(h || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
// specs table rows <tr><td>Key</td><td>Value</td></tr> → { Key: Value }
function parseSpecs(html) {
  const out = {};
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
async function listSarju(env) {
  const base = env.SARJU_BASE || SARJU_BASE, items = [];
  for (let page = 1, pages = 1; page <= pages && page <= 20; page++) {
    const r = await fetch(`${base}/wp-json/wc/store/v1/products?per_page=100&page=${page}`, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('Sarju site: HTTP ' + r.status);
    pages = parseInt(r.headers.get('X-WP-TotalPages') || '1') || 1;
    for (const p of await r.json()) {
      const name = tidyName(decode(p.name).replace(/^\s*sarju\s*[–—-]\s*/i, '').trim());
      const specs = parseSpecs(p.short_description + (p.description || ''));
      const model = ((specs['Model Number'] || '') + ' ' + name).match(/\b([A-Z]{1,4}-?\d{1,4}[A-Z]?)\b/i);
      items.push({
        id: p.id, name, url: p.permalink,
        model: model ? model[1].toUpperCase().replace('-', '') : '',
        cats: (p.categories || []).map(c => decode(c.name)).filter(c => !/^(popular|uncategori[sz]ed|new arrivals?|best sellers?)$/i.test(c)),
        specs,
        thumb: (p.images && p.images[0] && (p.images[0].thumbnail || p.images[0].src)) || '',
        images: (p.images || []).slice(0, 4).map(pickImg)
      });
    }
  }
  return items;
}
