/* ═══════════════════════════════════════════════════════════════════
   MNS Tours & Travels — Uber "Payments Transaction" report importer
   Shared by index.html (owner) and driver.html (Driver Manager).

   Where the file comes from:
     fleethub.uber.com → Reports → Generate Report → type "Payments Transaction" → Download (.csv)

   What it does:
     • reads the CSV in the browser (nothing is uploaded except the payouts you import)
     • shows a day-wise summary: trips, Uber earnings, cash the driver collected, Drive Pass fees, bank payouts
     • finds the bank payouts (rows "so.payout") — the money Uber sent to the manager's bank
     • each payout not yet in the Driver Ledger is added as  kind 'credit', platform 'Uber'
   A payout counts as "already entered" if the ledger has an Uber credit with its reference in the note,
   or on the same date for the same amount, or one typed by hand within ±2 days and ±₹1 (e.g. ₹2,124
   for ₹2,124.33) — so the same file can be uploaded again safely and hand entries aren't doubled.
   ═══════════════════════════════════════════════════════════════════ */
const UberReport = (() => {
  // Minimal CSV reader: handles quoted fields, commas and new lines inside quotes
  function readCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    text = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(v => v.trim() !== '')) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell); if (row.some(v => v.trim() !== '')) rows.push(row);
    return rows;
  }
  // Header names vary slightly ("Paid to you : Your earnings" vs "Paid to you:Your earnings") — compare without spaces/case
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = v => { const x = parseFloat(String(v || '').replace(/,/g, '')); return isNaN(x) ? 0 : x; };
  const r2 = x => Math.round(x * 100) / 100;

  /* → { days:[{date,trips,earnings,cash,pass,payout}], payouts:[{ref,date,amount}], drivers:[names], from, to, totals }
     Throws an Error with a plain message if this isn't a Payments Transaction report. */
  function parse(text) {
    const rows = readCsv(text);
    if (rows.length < 1) throw new Error('The file is empty.');
    const head = rows[0].map(norm);
    const col = (...names) => { for (const nm of names) { const i = head.indexOf(norm(nm)); if (i >= 0) return i; } return -1; };
    const colHas = part => head.findIndex(h => h.includes(norm(part)));
    const C = {
      ref: col('transaction UUID'), desc: col('Description'), at: col('Processed at'),
      first: col('Driver first name'), last: col('Driver surname'),
      paid: col('Paid to you'), earn: col('Paid to you : Your earnings'),
      cash: col('Paid to you : Trip balance : Payouts : Cash collected'),
      bank: colHas('Transferred To Bank Account'),
      trip: col('Trip UUID'), fare: col('Paid to you : Your earnings : Fare'),
      tip: col('Paid to you:Your earnings:Tip'), toll: col('Paid to you:Trip balance:Refunds:Toll'),
    };
    if (C.desc < 0 || C.at < 0 || C.paid < 0)
      throw new Error('This is not a Payments Transaction report. In Fleet Hub → Reports, download the one whose type is "Payments Transaction".');

    const byDay = {}, payouts = [], drivers = new Set(), txns = [];
    const v = (r, i) => i >= 0 ? n(r[i]) : 0;
    const day = d => byDay[d] = byDay[d] || { date: d, trips: 0, earnings: 0, cash: 0, pass: 0, payout: 0 };
    rows.slice(1).forEach(r => {
      const desc = String(r[C.desc] || '').trim(), at = String(r[C.at] || '').trim();
      const date = at.slice(0, 10);                       // "2026-10-20 04:21:13 +0530 IST" → 2026-10-20 (already India time)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const d = day(date), low = desc.toLowerCase();
      // Normalised copy of every row, saved on the server for the Uber tab (cash/toll/pass as positive amounts)
      const kind = low === 'so.payout' ? 'payout' : low.startsWith('trip completed') ? 'trip' : low.includes('drive pass') ? 'pass' : 'other';
      const ref = String(r[C.ref] || '').trim();
      if (ref && kind !== 'other') txns.push({ id: ref, date, time: (at.match(/\d{2}:\d{2}/) || [''])[0], kind, tripId: String(r[C.trip] || '').trim(),
        desc: desc.slice(0, 120), paid: r2(v(r, C.paid)), earnings: r2(v(r, C.earn)), fare: r2(v(r, C.fare)), tip: r2(v(r, C.tip)),
        toll: r2(v(r, C.toll)), cash: r2(-v(r, C.cash)), pass: kind === 'pass' ? r2(-v(r, C.paid)) : 0,
        payout: kind === 'payout' ? r2(Math.abs(C.bank >= 0 && v(r, C.bank) ? v(r, C.bank) : v(r, C.paid))) : 0 });
      if (low === 'so.payout') {
        const amt = r2(Math.abs(C.bank >= 0 && n(r[C.bank]) ? n(r[C.bank]) : n(r[C.paid])));
        if (amt > 0) { payouts.push({ ref: String(r[C.ref] || '').trim(), date, amount: amt }); d.payout += amt; }
      } else if (low.startsWith('trip completed')) {
        d.trips++;
        d.earnings += C.earn >= 0 ? n(r[C.earn]) : 0;
        d.cash += C.cash >= 0 ? -n(r[C.cash]) : 0;          // shown negative in the file = cash kept by the driver
        const nm = [r[C.first], r[C.last]].map(s => String(s || '').trim()).filter(Boolean).join(' ');
        if (nm) drivers.add(nm);
      } else if (low.includes('drive pass')) {
        d.pass += -n(r[C.paid]);
      }
    });
    const days = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date))
      .map(d => ({ ...d, earnings: r2(d.earnings), cash: r2(d.cash), pass: r2(d.pass), payout: r2(d.payout) }))
      .filter(d => d.trips || d.pass || d.payout);
    const sum = k => r2(days.reduce((t, d) => t + d[k], 0));
    return { days, payouts, txns, drivers: [...drivers], from: days.length ? days[0].date : '', to: days.length ? days[days.length - 1].date : '',
      totals: { trips: days.reduce((t, d) => t + d.trips, 0), earnings: sum('earnings'), cash: sum('cash'), pass: sum('pass'), payout: sum('payout') } };
  }

  // Which ledger driver do these trips belong to? Match by first name; one ledger driver → that one.
  function guessDriver(report, ledgerDrivers) {
    if (ledgerDrivers.length === 1) return ledgerDrivers[0].id;
    const firsts = report.drivers.map(x => x.split(' ')[0].toLowerCase());
    const hits = ledgerDrivers.filter(d => firsts.includes(String(d.name || '').split(' ')[0].toLowerCase()));
    return hits.length === 1 ? hits[0].id : '';
  }

  // Mark each payout as new or already in the ledger (checked against ALL drivers, so nothing is entered twice)
  function plan(report, entries) {
    const ub = (entries || []).filter(e => e.kind === 'credit' && String(e.platform || '').toLowerCase() === 'uber');
    return report.payouts.map(p => {
      const tag = p.ref ? p.ref.slice(0, 8) : '';
      // Exact: same reference, or same date + same amount.  Close: typed by hand, rounded (±₹1) and/or dated ±2 days.
      const days = e => Math.abs((new Date(e.date) - new Date(p.date)) / 864e5);
      const dup = ub.find(e => (tag && String(e.note || '').includes(tag)) || (e.date === p.date && Math.abs(n(e.amount) - p.amount) < 0.011))
               || ub.find(e => days(e) <= 2 && Math.abs(n(e.amount) - p.amount) <= 1);
      return { ...p, tag, exists: !!dup, match: dup && (dup.date !== p.date || Math.abs(n(dup.amount) - p.amount) >= 0.011) ? dup : null };
    });
  }

  const inr = x => { const a = Math.abs(Math.round(x * 100) / 100);
    return (x < -0.004 ? '−₹' : '₹') + a.toLocaleString('en-IN', { minimumFractionDigits: a % 1 ? 2 : 0, maximumFractionDigits: 2 }); };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fd = s => new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  /* Preview shown before importing. drivers = ledger drivers; selId = chosen driver id */
  function previewHtml(report, items, drivers, selId) {
    const T = report.totals, fresh = items.filter(i => !i.exists);
    const cell = 'padding:6px 4px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap';
    const box = (l, v, c) => `<div style="background:var(--surface2);border-radius:8px;padding:8px 10px"><small style="color:var(--text2);font-size:11px;display:block">${l}</small><b class="${c || ''}">${v}</b></div>`;
    return `
      <div style="color:var(--text2);font-size:13px;margin:2px 0 10px">${report.drivers.length ? esc(report.drivers.join(', ')) + ' · ' : ''}${report.from ? fd(report.from) + ' – ' + fd(report.to) : 'no trips'}</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px">
        ${box('Trips', T.trips)}${box('Uber earnings', inr(T.earnings))}
        ${box('Cash driver collected', inr(T.cash))}${box('Drive Pass fees', inr(T.pass), 'neg')}
      </div>
      <details style="margin-bottom:12px"><summary style="cursor:pointer;font-size:13px;color:var(--text2)">Day-wise summary (${report.days.length} days)</summary>
        <div style="overflow-x:auto;margin-top:6px"><table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr><th style="${cell};text-align:left">Day</th><th style="${cell}">Trips</th><th style="${cell}">Earnings</th><th style="${cell}">Cash</th><th style="${cell}">Pass</th><th style="${cell}">To bank</th></tr></thead>
          <tbody>${report.days.map(d => `<tr><td style="${cell};text-align:left">${fd(d.date)}</td><td style="${cell}">${d.trips || '—'}</td><td style="${cell}">${d.earnings ? inr(d.earnings) : '—'}</td>
            <td style="${cell}">${d.cash ? inr(d.cash) : '—'}</td><td style="${cell}">${d.pass ? inr(d.pass) : '—'}</td><td style="${cell}"><b>${d.payout ? inr(d.payout) : '—'}</b></td></tr>`).join('')}</tbody>
        </table></div></details>
      <div style="font-weight:700;font-size:14px;margin-bottom:6px">Uber payouts to bank (${items.length})</div>
      ${items.map(i => `<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span>${fd(i.date)} <span style="color:var(--text2);font-size:11px">${i.match ? '· already entered as ' + inr(n(i.match.amount)) + ' on ' + fd(i.match.date) : i.exists ? '· already entered' : '· new'}</span></span>
          <b class="${i.exists ? '' : 'pos'}" style="${i.exists ? 'color:var(--text2);font-weight:500' : ''}">${inr(i.amount)}</b></div>`).join('') || '<div style="color:var(--text2);font-size:13px">No payouts in this file.</div>'}
      ${fresh.length ? `<div class="field" style="margin-top:12px"><label>Add to driver</label>
          <select id="urDriver">${drivers.length > 1 && !selId ? '<option value="">— choose —</option>' : ''}${drivers.map(d => `<option value="${esc(d.id)}" ${d.id === selId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
        <div style="color:var(--text2);font-size:12px;margin-top:-4px">${fresh.length} new payout${fresh.length > 1 ? 's' : ''} · ${inr(fresh.reduce((t, i) => t + i.amount, 0))} will be added as “Uber → bank”.</div>`
        : `<div style="color:var(--text2);font-size:13px;margin-top:10px">✓ Every payout in this file is already in the ledger.</div>
           <div class="field" style="margin-top:12px"><label>Driver</label><select id="urDriver">${drivers.length > 1 && !selId ? '<option value="">— choose —</option>' : ''}${drivers.map(d => `<option value="${esc(d.id)}" ${d.id === selId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>`}
      <div style="color:var(--text2);font-size:12px;margin-top:8px">All ${report.txns.length} rows (trips, cash, tolls, Drive Pass) are saved for the driver’s Uber tab. Rows already saved are skipped.</div>`;
  }

  /* Add the new payouts one by one. post(body) → Promise<boolean>. Returns how many were added. */
  async function importNew(items, driverId, post) {
    let added = 0;
    for (const i of items.filter(x => !x.exists)) {
      const ok = await post({ driverId, kind: 'credit', platform: 'Uber', date: i.date, amount: i.amount,
        note: 'Uber payout (report)' + (i.tag ? ' · ' + i.tag : '') });
      if (!ok) break;
      added++;
    }
    return added;
  }

  // File shared to the app from Android's Share menu (saved by sw.js) → {name, text}, or null. Removed once taken.
  async function takeShared() {
    if (!/[?&]shared=1/.test(location.search) || !('caches' in window)) return null;
    try { history.replaceState(null, '', location.pathname); } catch {}
    try {
      const c = await caches.open('mns-share'), r = await c.match('./shared-file');
      if (!r) return null;
      const text = await r.text(); await c.delete('./shared-file');
      return { name: decodeURIComponent(r.headers.get('X-Name') || 'report.csv'), text };
    } catch { return null; }
  }
  const isShared = () => /[?&]shared=1/.test(location.search);

  // Ask the browser for a .csv file → its text
  function pickFile() {
    return new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.csv,text/csv';
      inp.onchange = () => { const f = inp.files[0]; if (!f) return resolve(null); const rd = new FileReader();
        rd.onload = () => resolve({ name: f.name, text: rd.result }); rd.onerror = () => resolve(null); rd.readAsText(f); };
      inp.click();
    });
  }

  /* ── Uber tab: day-wise view of saved rows for one driver ──
     rows = server rows {id,date,time,kind,paid,earnings,fare,tip,toll,cash,pass,payout}
     key  = unique id for this view (driver id); state (month, open days) is kept here.
     redraw = function the page calls to re-render after a tap. */
  const ST = {};
  function viewHtml(key, rows, redraw) {
    const st = ST[key] = ST[key] || { month: '', open: {} };
    ST[key].redraw = redraw;
    if (!rows.length) return `<div style="color:var(--text2);font-size:13px;padding:14px 0">No Uber data yet. Upload the Fleet Hub “Payments Transaction” report to see trips, cash, tolls and Drive Pass fees here.</div>`;
    const months = [...new Set(rows.map(r => r.date.slice(0, 7)))].sort();
    if (!st.month || !months.includes(st.month)) st.month = months[months.length - 1];
    const mi = months.indexOf(st.month), list = rows.filter(r => r.date.startsWith(st.month));
    const days = {};
    list.forEach(r => { const d = days[r.date] = days[r.date] || { date: r.date, trips: [], fare: 0, cash: 0, toll: 0, tip: 0, pass: 0, payout: 0 };
      if (r.kind === 'trip') { d.trips.push(r); d.fare += n(r.earnings); d.cash += n(r.cash); d.toll += n(r.toll); d.tip += n(r.tip); }
      if (r.kind === 'pass') d.pass += n(r.pass);
      if (r.kind === 'payout') d.payout += n(r.payout); });
    const dl = Object.values(days).sort((a, b) => b.date.localeCompare(a.date));
    const S = k => dl.reduce((t, d) => t + d[k], 0), trips = dl.reduce((t, d) => t + d.trips.length, 0);
    const mname = new Date(st.month + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const nav = (dir, ok) => `<button type="button" onclick="UberReport.month('${esc(key)}',${dir})" ${ok ? '' : 'disabled'} style="border:1px solid var(--border);background:var(--surface);border-radius:8px;padding:6px 12px;font:inherit;${ok ? 'cursor:pointer' : 'opacity:.3'}">${dir < 0 ? '‹' : '›'}</button>`;
    const box = (l, val, c) => `<div style="background:var(--surface2);border-radius:8px;padding:8px 10px"><small style="color:var(--text2);font-size:11px;display:block">${l}</small><b class="${c || ''}">${val}</b></div>`;
    const td = 'padding:7px 4px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap';
    const tdS = 'padding:5px 4px;text-align:right;white-space:nowrap;font-size:11px;color:var(--text2)';
    return `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">${nav(-1, mi > 0)}<b>${mname}</b>${nav(1, mi < months.length - 1)}</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px">
        ${box('Trips', trips)}${box('Fare earned', inr(S('fare')))}
        ${box('Cash he collected', inr(S('cash')))}${box('Tolls', inr(S('toll')))}
        ${box('Drive Pass fees', inr(S('pass')), 'neg')}${box('Uber → bank', inr(S('payout')), 'pos')}
      </div>
      <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="color:var(--text2)"><th style="${td};text-align:left">Day</th><th style="${td}">Trips</th><th style="${td}">Fare</th><th style="${td}">Cash</th><th style="${td}">Toll</th><th style="${td}">Pass</th><th style="${td}">To bank</th></tr></thead>
        <tbody>${dl.map(d => {
          const open = st.open[d.date];
          return `<tr style="cursor:pointer" onclick="UberReport.toggle('${esc(key)}','${d.date}')">
              <td style="${td};text-align:left">${fd(d.date)} <span style="color:var(--text2)">${d.trips.length ? (open ? '▴' : '▾') : ''}</span></td>
              <td style="${td}">${d.trips.length || '—'}</td><td style="${td}">${d.fare ? inr(d.fare) : '—'}</td><td style="${td}">${d.cash ? inr(d.cash) : '—'}</td>
              <td style="${td}">${d.toll ? inr(d.toll) : '—'}</td><td style="${td}" class="${d.pass ? 'neg' : ''}">${d.pass ? inr(d.pass) : '—'}</td>
              <td style="${td}" class="${d.payout ? 'pos' : ''}"><b>${d.payout ? inr(d.payout) : '—'}</b></td></tr>`
            + (open ? d.trips.slice().sort((a, b) => String(a.time).localeCompare(String(b.time))).map(t => `<tr style="background:var(--surface2)">
              <td style="${tdS};text-align:left">&nbsp;&nbsp;${esc(t.time || '')}</td><td style="${tdS}">${n(t.cash) ? 'cash' : 'online'}</td>
              <td style="${tdS}">${inr(n(t.earnings))}${n(t.tip) ? ' <span title="tip">+tip</span>' : ''}</td><td style="${tdS}">${n(t.cash) ? inr(n(t.cash)) : '—'}</td>
              <td style="${tdS}">${n(t.toll) ? inr(n(t.toll)) : '—'}</td><td style="${tdS}"></td><td style="${tdS}"></td></tr>`).join('') : '');
        }).join('')}</tbody></table></div>
      <div style="color:var(--text2);font-size:11px;margin-top:8px">Fare = Uber earnings for the trip. Cash = what the driver took from riders. Toll = paid back by Uber. Pass = Uber's Drive Pass fee. To bank = Uber payout to the manager's bank (already counted in the ledger). Tap a day for its trips.</div>`;
  }
  function toggle(key, date) { const st = ST[key]; if (!st) return; st.open[date] = !st.open[date]; st.redraw && st.redraw(); }
  function month(key, dir) { const st = ST[key]; if (!st) return; const d = new Date(st.month + '-01T00:00:00'); d.setMonth(d.getMonth() + dir);
    st.month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); st.redraw && st.redraw(); }

  /* Save all rows of the report for one driver. post(path, body) → Promise<{ok, body}>. */
  async function saveRows(report, driverId, post) {
    let added = 0, ok = true;
    for (let i = 0; i < report.txns.length; i += 400) {
      const r = await post('/ledger/uber', { driverId, rows: report.txns.slice(i, i + 400) });
      if (!r || !r.ok) { ok = false; break; }
      added += r.body.added || 0;
    }
    return { ok, added };
  }

  /* ── Earnings tab: one rent day at a time (8 PM previous day → 8 PM), with the settlement ──
     rows  = saved Uber rows of ONE driver; rent = his daily rent to the manager
     who   = { driver:'Siddique', manager:'Naushad', me:'owner'|'manager'|'driver' }
     Per trip:  earned = paid + cash − toll   (booking fee and tax cancel out)
     Day:       online (Uber holds) = Σ paid of trips = earned + tolls − cash
                Uber → manager's bank = online − Drive Pass
                driver gives = rent − Uber → bank   (negative → manager gives the driver)   */
  // Day split. For now each day = calendar day (12 AM → 11:59 PM), same as Uber's daily report.
  // To go back to 8 PM → 8 PM rent days, set SPLIT_AT = '20:00'.
  const SPLIT_AT = '';
  const rentDay = r => {                       // with SPLIT_AT set, a trip finished at/after that time belongs to the next day
    if (!SPLIT_AT || String(r.time || '') < SPLIT_AT) return r.date;
    const d = new Date(r.date + 'T00:00:00'); d.setDate(d.getDate() + 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  function earnDays(rows) {
    const D = {};
    rows.forEach(r => {
      if (r.kind !== 'trip' && r.kind !== 'pass' && r.kind !== 'payout') return;
      const k = r.kind === 'payout' ? r.date : rentDay(r);
      const d = D[k] = D[k] || { day: k, trips: [], earned: 0, toll: 0, tip: 0, cash: 0, online: 0, onl: 0, adj: 0, pass: 0, payout: 0 };
      if (r.kind === 'trip') {
        const earned = r2(n(r.paid) + n(r.cash) - n(r.toll));
        d.trips.push({ ...r, earned, online: r2(n(r.paid)) });
        d.earned += earned; d.toll += n(r.toll); d.tip += n(r.tip); d.cash += n(r.cash); d.online += n(r.paid);
        if (n(r.cash) > 0) d.adj += n(r.paid); else d.onl += n(r.paid);   // cash trip: Uber's small +/- difference; online trip: full amount
      } else if (r.kind === 'pass') d.pass += n(r.pass);
      else d.payout += n(r.payout);
    });
    return Object.values(D).map(d => ({ ...d, earned: r2(d.earned), toll: r2(d.toll), tip: r2(d.tip), cash: r2(d.cash), online: r2(d.online), onl: r2(d.onl), adj: r2(d.adj),
      pass: r2(d.pass), payout: r2(d.payout), toBank: r2(d.online - d.pass) })).sort((a, b) => a.day.localeCompare(b.day));
  }
  function earningsHtml(key, rows, rent, who, redraw) {
    const st = ST['e:' + key] = ST['e:' + key] || { day: '' };
    ST['e:' + key].redraw = redraw;
    const days = earnDays(rows).filter(d => d.trips.length || d.pass);
    if (!days.length) return `<div style="color:var(--text2);font-size:13px;padding:14px 0">No Uber data yet. Upload the Fleet Hub “Payments Transaction” report (Driver ledger → ⬆ Uber report) to see earnings here.</div>`;
    if (!st.day || !days.some(d => d.day === st.day)) st.day = days[days.length - 1].day;
    if (st._dir) { const j = days.findIndex(x => x.day === st.day) + st._dir; if (j >= 0 && j < days.length) st.day = days[j].day; st._dir = 0; }
    const i = days.findIndex(d => d.day === st.day), d = days[i];
    const give = r2(n(rent) - d.toBank), drv = esc(who.driver || 'Driver'), mgr = esc(who.manager || 'Manager');
    const isDrv = who.me === 'driver', isMgr = who.me === 'manager';
    const prev = new Date(d.day + 'T00:00:00'); prev.setDate(prev.getDate() - 1);
    const range = SPLIT_AT ? prev.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' 8 PM → ' + fd(d.day) + ' 8 PM'
      : new Date(d.day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long' }) + ' · 12 AM → 11:59 PM';
    const nav = (dir, ok) => `<button type="button" onclick="UberReport.eday('${esc(key)}',${dir})" ${ok ? '' : 'disabled'} style="border:1px solid var(--border);background:var(--surface);border-radius:8px;padding:6px 14px;font:inherit;font-size:16px;${ok ? 'cursor:pointer' : 'opacity:.3'}">${dir < 0 ? '‹' : '›'}</button>`;
    const line = (l, v, opt = {}) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;${opt.top ? 'border-top:1px solid var(--border);margin-top:4px;padding-top:8px;' : ''}font-size:${opt.big ? 15 : 13}px">
        <span style="${opt.muted ? 'color:var(--text2)' : ''}">${l}</span><b class="${opt.cls || ''}" style="white-space:nowrap">${v}</b></div>`;
    const sub = (l, v, cls) => line(l, v, { cls, muted: true });
    const tripRows = d.trips.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map((t, k) => {
      const isCash = n(t.cash) > 0;
      return `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
        <div><b>Trip ${k + 1}</b> <span style="color:var(--text2)">· ${fd(t.date)} ${esc(t.time || '')}</span>
          <div style="color:var(--text2);font-size:12px;margin-top:2px">${isCash ? 'Cash ' + inr(n(t.cash)) : 'Online'}${n(t.toll) ? ' · toll ' + inr(n(t.toll)) : ''}${n(t.tip) ? ' · tip ' + inr(n(t.tip)) : ''}</div></div>
        <div style="text-align:right"><b>${inr(t.earned)}</b><div style="font-size:11px;font-weight:700;color:${isCash ? 'var(--text2)' : 'var(--green)'}">${isCash ? 'CASH' : 'ONLINE'}</div></div></div>`;
    }).join('');
    const settle = give > 0.004
      ? `<div style="background:var(--red-soft);border-radius:10px;padding:12px;margin-top:10px;text-align:center"><div style="font-size:12px;color:var(--text2)">${isDrv ? 'You give ' + mgr : drv + ' gives ' + mgr}</div><div style="font-size:26px;font-weight:800" class="neg">${inr(give)}</div></div>`
      : give < -0.004
        ? `<div style="background:var(--green-soft);border-radius:10px;padding:12px;margin-top:10px;text-align:center"><div style="font-size:12px;color:var(--text2)">${isMgr ? 'You give ' + drv : mgr + ' gives ' + (isDrv ? 'you' : drv)}</div><div style="font-size:26px;font-weight:800" class="pos">${inr(-give)}</div></div>`
        : `<div style="background:var(--surface2);border-radius:10px;padding:12px;margin-top:10px;text-align:center;font-weight:700">✓ Nothing to give either way</div>`;
    const keep = r2(d.earned - d.pass - n(rent));
    return `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">${nav(-1, i > 0)}
        <div style="text-align:center"><b style="font-size:16px">${fd(d.day)}</b><div style="font-size:11px;color:var(--text2)">${range}</div></div>${nav(1, i < days.length - 1)}</div>
      <div style="margin:10px 0 4px;font-weight:700;font-size:14px">Trips (${d.trips.length})</div>
      ${tripRows || '<div style="color:var(--text2);font-size:13px;padding:8px 0">No trips this day</div>'}
      <div style="margin:14px 0 2px;font-weight:700;font-size:14px">Earnings</div>
      ${line('Total trips', d.trips.length)}
      ${line('Total online (with Uber)', inr(d.onl), { cls: 'pos' })}
      ${line('Total cash (with ' + (isDrv ? 'you' : drv) + ')', inr(d.cash))}
      ${d.adj ? line((d.adj < 0 ? '−' : '+') + ' Uber difference on cash trips', (d.adj < 0 ? '−' : '+') + inr(Math.abs(d.adj)), { muted: true }) : ''}
      ${d.toll ? line('− Tolls (paid at toll booths)', '−' + inr(d.toll), { muted: true }) : ''}
      ${line('= Total earning', inr(d.earned), { top: true, big: true })}
      <div style="margin:14px 0 2px;font-weight:700;font-size:14px">Uber account</div>
      ${line('Online trips', inr(d.onl))}
      ${d.adj ? line('Difference on cash trips', (d.adj < 0 ? '−' : '+') + inr(Math.abs(d.adj)), { cls: d.adj < 0 ? 'neg' : '' }) : ''}
      ${d.adj < 0 ? `<div style="font-size:11px;color:var(--text2)">Riders paid a little more cash than the driver's fare (Uber's part, incl. tolls). Uber takes it from the online money.</div>` : ''}
      ${d.toll ? sub('Tolls Uber pays back (included)', inr(d.toll)) : ''}${d.tip ? sub('Tips (included)', inr(d.tip)) : ''}
      ${line('− Drive Pass', d.pass ? '−' + inr(d.pass) : '₹0', { cls: d.pass ? 'neg' : '' })}
      ${line('= Uber sends to ' + mgr + '’s bank', inr(d.toBank), { top: true, cls: d.toBank < 0 ? 'neg' : 'pos' })}
      ${d.toBank < 0 ? `<div style="font-size:11px;color:var(--text2)">Negative: Uber takes this from the next online money.</div>` : ''}
      <div style="margin:14px 0 2px;font-weight:700;font-size:14px">Settlement</div>
      ${line('Rent', inr(n(rent)))}
      ${d.toBank < 0 ? line('+ Uber will cut from ' + mgr + '’s next payout', '+' + inr(-d.toBank)) : line('− Uber sends to ' + mgr + '’s bank', '−' + inr(d.toBank))}
      ${settle}
      <div style="font-size:12px;color:var(--text2);margin-top:8px;text-align:center">${isDrv ? 'Your' : drv + '’s'} earnings after rent &amp; Drive Pass: <b class="${keep < 0 ? 'neg' : 'pos'}">${inr(keep)}</b></div>
      ${d.payout ? `<div style="font-size:11px;color:var(--text2);margin-top:6px;text-align:center">Actual Uber payout that reached the bank on ${fd(d.day)}: ${inr(d.payout)} (for earlier days)</div>` : ''}
      <details style="margin-top:14px"><summary style="cursor:pointer;font-size:13px;color:var(--text2)">All days</summary>
        <div style="overflow-x:auto;margin-top:6px"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="color:var(--text2)">
          <th style="text-align:left;padding:5px 3px">Day</th><th style="text-align:right;padding:5px 3px">Trips</th><th style="text-align:right;padding:5px 3px">Earned</th><th style="text-align:right;padding:5px 3px">Cash</th><th style="text-align:right;padding:5px 3px">Pass</th><th style="text-align:right;padding:5px 3px">To bank</th><th style="text-align:right;padding:5px 3px">${isDrv ? 'You give' : 'Driver gives'}</th></tr></thead>
          <tbody>${days.slice().reverse().map(x => { const g = r2(n(rent) - x.toBank); return `<tr style="cursor:pointer;border-top:1px solid var(--border)" onclick="UberReport.eset('${esc(key)}','${x.day}')">
            <td style="padding:6px 3px">${fd(x.day)}</td><td style="text-align:right;padding:6px 3px">${x.trips.length}</td><td style="text-align:right;padding:6px 3px">${inr(x.earned)}</td><td style="text-align:right;padding:6px 3px">${inr(x.cash)}</td>
            <td style="text-align:right;padding:6px 3px">${x.pass ? inr(x.pass) : '—'}</td><td style="text-align:right;padding:6px 3px" class="${x.toBank < 0 ? 'neg' : 'pos'}">${inr(x.toBank)}</td><td style="text-align:right;padding:6px 3px" class="${g > 0 ? 'neg' : 'pos'}"><b>${inr(g)}</b></td></tr>`; }).join('')}</tbody></table></div>
        <div style="font-size:11px;color:var(--text2);margin-top:6px">${SPLIT_AT ? 'Each day runs 8 PM to 8 PM.' : 'Each day = 12 AM to 11:59 PM.'} These are per-day figures; the running balance (incl. cash already given) is in the Driver ledger.</div></details>`;
  }
  function eday(key, dir) { const st = ST['e:' + key]; if (!st) return; st.move = dir; st.redraw && (st._dir = dir, st.redraw()); }
  function eset(key, day) { const st = ST['e:' + key]; if (!st) return; st.day = day; st.redraw && st.redraw(); window.scrollTo(0, 0); }

  return { parse, plan, guessDriver, previewHtml, importNew, pickFile, viewHtml, toggle, month, saveRows, earningsHtml, eday, eset, earnDays, takeShared, isShared };
})();
