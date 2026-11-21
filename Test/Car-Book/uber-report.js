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

  return { parse, plan, guessDriver, previewHtml, importNew, pickFile, viewHtml, toggle, month, saveRows };
})();
