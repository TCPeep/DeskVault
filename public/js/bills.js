// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Bills page: what's due, what's overdue, what this month costs, and a calendar of it all.
// All dates are plain YYYY-MM-DD in your local time; the server only stores and validates them.
import { S, refresh, parseHash, load, save } from './state.js';
import { post } from './api.js';
import * as ui from './ui.js';
import { unlock, lockNow, setLock } from './actions.js';
const { esc, icon } = ui;

// ---------- constants ----------
export const FREQ = {
  weekly: ['Weekly', 52 / 12], biweekly: ['Every 2 weeks', 26 / 12], monthly: ['Monthly', 1], quarterly: ['Every 3 months', 1 / 3],
  semiannual: ['Every 6 months', 1 / 6], yearly: ['Yearly', 1 / 12], once: ['One time', 0],
};
const CATS = {
  Housing: '#818cf8', Utilities: '#fbbf24', 'Internet & phone': '#22d3ee', Insurance: '#34d399', Transport: '#fb923c',
  Subscriptions: '#f472b6', 'Loans & cards': '#f87171', Health: '#a3e635', Family: '#a78bfa', Other: '#94a3b8',
};
const TEMPLATES = [
  ['Rent', 'Housing'], ['Mortgage', 'Housing'], ['Electric', 'Utilities'], ['Water', 'Utilities'], ['Gas', 'Utilities'],
  ['Internet', 'Internet & phone'], ['Phone', 'Internet & phone'], ['Car insurance', 'Insurance'], ['Car payment', 'Transport'],
  ['Credit card', 'Loans & cards'], ['Streaming', 'Subscriptions'], ['Gym', 'Health'],
];
const CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'MXN', 'JPY', 'INR', 'BRL', 'ZAR', 'SEK', 'NOK', 'DKK', 'CHF', 'PLN'];
const HORIZON = 45; // days of upcoming bills to list
const REPEATS = 14; // later repeats of the same bill (weekly, every 2 weeks) are listed only this far ahead

const B = { page: null, month: null };
const host = () => (parseHash().name === 'bills' ? B.page?.querySelector('#billsPage') : null);

// ---------- dates ----------
const pad = n => String(n).padStart(2, '0');
const ymdLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => ymdLocal(new Date());
const utc = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const ymdUtc = t => new Date(t).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / 86400000);
const addDays = (s, n) => ymdUtc(utc(s) + n * 86400000);
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const monthOf = s => s.slice(0, 7);
const monthEnd = ym => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(daysIn(y, m - 1))}`; };
const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); const t = m - 1 + n; return `${y + Math.floor(t / 12)}-${pad(((t % 12) + 12) % 12 + 1)}`; };
const monthName = (ym, long = true) => new Date(utc(ym + '-01')).toLocaleDateString(undefined, { month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' });
const niceDate = s => new Date(utc(s)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(s.slice(0, 4) !== today().slice(0, 4) ? { year: 'numeric' } : {}), timeZone: 'UTC' });
const paidMonth = p => monthOf(ymdLocal(new Date(p.paidAt)));

/** Same rule as the server (lib/bills.js): month-based bills keep their day of month. */
function advance(date, freq, anchorDay) {
  const [y, m, d] = date.split('-').map(Number);
  if (freq === 'weekly' || freq === 'biweekly') return addDays(date, freq === 'weekly' ? 7 : 14);
  const add = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 }[freq];
  if (!add) return null;
  const t = m - 1 + add, ny = y + Math.floor(t / 12), nm = ((t % 12) + 12) % 12;
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(anchorDay || d, daysIn(ny, nm)))}`;
}

const active = b => !b.done && !b.paused && b.dueDate;
/** Unpaid due dates from the bill's next due date up to `to` (overdue ones included). */
function occurrences(b, to) {
  const out = [];
  if (!active(b)) return out;
  for (let d = b.dueDate, n = 0; d && d <= to && n < 400; d = advance(d, b.frequency, b.anchorDay), n++) out.push(d);
  return out;
}

// ---------- money ----------
let fmtCache = { cur: null, f: null };
export function money(n) {
  const cur = S.settings.billCurrency || 'USD';
  if (fmtCache.cur !== cur) {
    try { fmtCache = { cur, f: new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }) }; }
    catch { fmtCache = { cur, f: new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }; }
  }
  return fmtCache.f.format(Number(n) || 0);
}
const amt = (n, cls = '') => `<span class="amt ${cls}">${esc(money(n))}</span>`;
const sum = arr => Math.round(arr.reduce((a, b) => a + (Number(b) || 0), 0) * 100) / 100;
const perMonth = b => (active(b) ? b.amount * (FREQ[b.frequency]?.[1] ?? 0) : 0);

function catColor(name) {
  if (CATS[name]) return CATS[name];
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ui.COLORS[h % ui.COLORS.length];
}

// ---------- status ----------
/** -> { k: overdue|check|today|soon|later|paused|done, d: days until due (negative = late), label, cls } */
export function statusOf(b, t = today()) {
  if (b.done) return { k: 'done', label: 'Paid off', cls: 'muted' };
  if (b.paused) return { k: 'paused', label: 'Paused', cls: 'muted' };
  const d = daysBetween(t, b.dueDate);
  const late = -d === 1 ? '1 day' : `${-d} days`;
  if (d < 0 && b.autopay) return { k: 'check', d, label: `Auto-pay ${late} ago. Went through?`, cls: 'info' };
  if (d < 0) return { k: 'overdue', d, label: `${late} late`, cls: 'danger' };
  if (d === 0) return { k: 'today', d, label: b.autopay ? 'Auto-pays today' : 'Due today', cls: b.autopay ? 'info' : 'warn' };
  const when = d === 1 ? 'tomorrow' : `in ${d} days`;
  if (d <= (b.remindDays ?? 3)) return { k: 'soon', d, label: `Due ${when}`, cls: b.autopay ? 'info' : 'warn' };
  return { k: 'later', d, label: `Due ${when}`, cls: 'muted' };
}

/** Sidebar badge: how many bills want you right now. */
export function billsBadge() {
  const t = today();
  let n = 0, alert = false;
  for (const b of S.bills || []) {
    const s = statusOf(b, t);
    if (s.k === 'overdue') { n++; alert = true; } else if (s.k === 'today' || s.k === 'check' || (s.k === 'soon' && !b.autopay)) n++;
  }
  return { n, alert };
}

function stats() {
  const t = today(), ym = monthOf(t), end = monthEnd(ym);
  const bills = S.bills || [];
  const occ = bills.flatMap(b => occurrences(b, end).map(d => ({ b, d })));
  const overdue = occ.filter(o => o.d < t && !o.b.autopay);
  const left = sum(occ.map(o => o.b.amount));
  // This month's progress counts what was *due* this month (rent paid on Oct 31 for Nov 1 counts for November).
  const paid = sum(bills.flatMap(b => b.payments.filter(p => !p.skipped && monthOf(p.dueDate) === ym).map(p => p.amount)));
  const week = bills.flatMap(b => occurrences(b, addDays(t, 7)).filter(d => d >= t).map(d => ({ b, d })));
  const monthly = sum(bills.map(perMonth));
  return {
    t, ym, monthly, yearly: Math.round(monthly * 12 * 100) / 100, left, paid,
    overdue, overdueAmt: sum(overdue.map(o => o.b.amount)), week, weekAmt: sum(week.map(o => o.b.amount)),
    autopayMonthly: sum(bills.filter(b => b.autopay).map(perMonth)), count: bills.filter(active).length,
  };
}

// ---------- render ----------
export function renderBills(page) {
  B.page = page;
  B.month ||= monthOf(today());
  document.body.classList.toggle('bills-private', load('billsHide', '0') === '1');
  if (!page.querySelector('#billsPage')) page.innerHTML = '<div id="billsPage"></div>';
  draw();
}

function draw() {
  const el = host();
  if (!el) return;
  const L = S.app.lock || {};
  if (L.bills && !L.unlocked) {
    el.innerHTML = `<div class="lockscreen"><div class="tile xl c-lock">${icon('lock')}</div><h2>Bills are locked</h2>
      <p>Unlock with your Windows PIN, fingerprint or face to see amounts and due dates.${L.help ? `<br><b>${esc(L.help)}</b>` : ''}</p>
      <button class="btn primary" data-act="unlock">${icon('unlock')}Unlock with Windows Hello</button></div>`;
    return;
  }
  const bills = S.bills || [];
  const hide = document.body.classList.contains('bills-private');
  const head = `<div class="page-head"><h1>${icon('receipt')}Bills</h1><span class="sub">${bills.length ? `${bills.filter(active).length} active` : 'Never miss a due date'}</span><div class="grow"></div>
    <button class="icon-btn ${hide ? 'on' : ''}" data-act="privacy" title="${hide ? 'Show amounts' : 'Hide amounts (for screen sharing)'}">${icon(hide ? 'eye-off' : 'eye')}</button>
    ${L.bills ? `<button class="icon-btn on" data-act="lock-now" title="Bills lock with Windows Hello. Click to lock now">${icon('unlock')}</button>` : ''}
    <button class="icon-btn" data-act="settings" title="Bill settings">${icon('settings')}</button>
    ${bills.length ? `<button class="btn" data-act="export">${icon('download')}Export</button>` : ''}
    <button class="btn primary" data-act="add">${icon('plus')}Add bill</button></div>`;
  if (!bills.length) { el.innerHTML = head + emptyHtml(); return; }

  const s = stats();
  const monthTotal = s.paid + s.left;
  const pct = monthTotal ? Math.round(s.paid / monthTotal * 100) : 100;
  const attention = bills.map(b => ({ b, st: statusOf(b, s.t) })).filter(x => x.st.k === 'overdue' || x.st.k === 'check' || (x.st.k === 'today' && !x.b.autopay));

  el.innerHTML = head + `
    ${attention.length ? `<div class="banner ${attention.some(x => x.st.k === 'overdue') ? 'danger' : 'warn'}">${icon('alert')}<div class="grow">
      <b>${attention.length === 1 ? '1 bill needs you' : `${attention.length} bills need you`}</b>
      <div class="bill-mini">${attention.map(({ b, st }) => `<div class="li" data-bill="${esc(b.id)}"><span class="nm">${esc(b.name)}</span>${amt(b.amount)}<span class="badge ${st.cls}">${esc(st.label)}</span>
        <button class="btn sm" data-act="pay">${icon('check')}${st.k === 'check' ? 'It went through' : 'Paid'}</button></div>`).join('')}</div></div></div>` : ''}

    <div class="kpis">
      <div class="kpi"><div class="k">${icon('receipt')}Monthly total</div><div class="v">${amt(s.monthly)}</div>
        <div class="s">${amt(s.yearly)} a year · ${s.count} bill${s.count === 1 ? '' : 's'}${s.autopayMonthly ? ` · ${amt(s.autopayMonthly)} on auto-pay` : ''}</div></div>
      <div class="kpi"><div class="k">${icon('calendar')}Left to pay in ${esc(monthName(s.ym, true).split(' ')[0])}</div><div class="v">${amt(s.left)}</div>
        <div class="bar" style="margin:6px 0 4px"><div style="width:${pct}%"></div></div><div class="s">${amt(s.paid)} paid · ${pct}% done</div></div>
      <div class="kpi"><div class="k">${icon('clock')}Next 7 days</div><div class="v">${amt(s.weekAmt)}</div>
        <div class="s">${s.week.length ? `${s.week.length} payment${s.week.length === 1 ? '' : 's'} · next: ${esc(s.week[0].b.name)} ${esc(relDay(s.week[0].d, s.t))}` : 'Nothing due this week'}</div></div>
      <div class="kpi ${s.overdue.length ? 'bad' : 'good'}"><div class="k">${icon(s.overdue.length ? 'alert' : 'check-circle')}Overdue</div><div class="v">${s.overdue.length ? amt(s.overdueAmt) : 'All clear'}</div>
        <div class="s">${s.overdue.length ? `${s.overdue.length} payment${s.overdue.length === 1 ? '' : 's'} late` : 'Nothing late. Nice.'}</div></div>
    </div>

    <div class="panels bill-panels">
      <section class="panel"><h2>${icon('clock')}Coming up</h2><p class="desc">Each bill's next due date (next ${HORIZON} days), plus anything late.</p>${upcomingHtml(s.t)}</section>
      <div class="bill-side">
        <section class="panel">${calendarHtml(s.t)}</section>
        <section class="panel"><h2>${icon('pie')}Where it goes</h2><p class="desc">Per month, by category.</p>${categoryHtml(s.monthly)}</section>
        <section class="panel"><h2>${icon('history')}Paid per month</h2><p class="desc">What you actually paid, last 6 months.</p>${historyHtml(s.ym)}</section>
      </div>
    </div>

    <section class="panel"><h2>${icon('layers')}All bills</h2><p class="desc">Click a bill to edit it. Per month evens out weekly and yearly bills so they add up.</p>${tableHtml(s.t)}</section>`;
}

function relDay(d, t) {
  const n = daysBetween(t, d);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n < 0 ? `${-n} days ago` : n < 7 ? `on ${new Date(utc(d)).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' })}` : `in ${n} days`;
}

function billTile(b) {
  return `<div class="tile" style="--c:${catColor(b.category)}">${icon(b.autopay ? 'zap' : 'receipt')}</div>`;
}

function upcomingHtml(t) {
  const to = addDays(t, HORIZON);
  const near = addDays(t, REPEATS);
  const occ = (S.bills || []).flatMap(b => occurrences(b, to).map((d, i) => ({ b, d, first: i === 0 })).filter(o => o.first || o.d <= near)).sort((x, y) => x.d.localeCompare(y.d) || x.b.name.localeCompare(y.b.name));
  if (!occ.length) return '<div class="muted" style="padding:10px 0">Nothing due in the next few weeks.</div>';
  const groups = [
    ['Late', o => o.d < t], ['Today', o => o.d === t], ['Next 7 days', o => o.d > t && o.d <= addDays(t, 7)],
    ['Later this month', o => o.d > addDays(t, 7) && monthOf(o.d) === monthOf(t)], ['After that', () => true],
  ];
  const used = new Set();
  return groups.map(([label, f]) => {
    const rows = occ.filter(o => !used.has(o) && f(o));
    rows.forEach(o => used.add(o));
    if (!rows.length) return '';
    return `<div class="bill-group"><h3>${esc(label)}<span>${amt(sum(rows.map(o => o.b.amount)))}</span></h3>${rows.map(o => upRow(o, t)).join('')}</div>`;
  }).join('');
}

function upRow({ b, d, first }, t) {
  const st = first ? statusOf(b, t) : null;
  const tags = [
    b.autopay ? `<span class="badge info">${icon('zap')}Auto-pay</span>` : '',
    b.variable ? '<span class="badge muted" title="The amount changes; this is the last amount paid">≈ estimate</span>' : '',
  ].join('');
  return `<div class="bill-row ${first ? '' : 'later'} ${st ? 'st-' + st.k : ''}" data-bill="${esc(b.id)}">
    ${billTile(b)}
    <div class="bm"><div class="bt"><span class="name">${esc(b.name)}</span>${tags}</div>
      <div class="bs">${esc(niceDate(d))} · ${st ? `<span class="${st.cls === 'muted' ? '' : 'tx-' + st.cls}">${esc(st.label)}</span>` : esc(relDay(d, t))}${b.last4 ? ` · ••${esc(b.last4)}` : ''}</div></div>
    <div class="ba">${amt(b.amount)}</div>
    <div class="bx">${first ? `${b.payUrl && !b.autopay ? `<a class="icon-btn" href="${esc(b.payUrl)}" target="_blank" rel="noopener noreferrer" title="Open the payment site">${icon('external')}</a>` : ''}
      <button class="btn sm ${st && ['overdue', 'today'].includes(st.k) ? 'primary' : ''}" data-act="pay" title="Mark this one paid">${icon('check')}${st?.k === 'check' ? 'Went through' : 'Paid'}</button>` : '<span class="badge muted" title="Pay the one before first">next one</span>'}
      <button class="icon-btn" data-act="menu" title="More">${icon('more')}</button></div>
  </div>`;
}

function calendarHtml(t) {
  const ym = B.month, [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const n = daysIn(y, m - 1);
  const end = monthEnd(ym);
  const byDay = {};
  const put = (d, x) => { (byDay[d] ||= []).push(x); };
  for (const b of S.bills || []) {
    for (const d of occurrences(b, end)) if (monthOf(d) === ym) put(d, { b, paid: false });
    for (const p of b.payments) if (monthOf(p.dueDate) === ym) put(p.dueDate, { b, paid: !p.skipped, skipped: p.skipped });
  }
  const total = sum(Object.values(byDay).flat().filter(x => !x.skipped).map(x => x.b.amount));
  const wd = [...Array(7)].map((_, i) => new Date(Date.UTC(2023, 0, 1 + i)).toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' }));
  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<div class="cd pad"></div>');
  for (let d = 1; d <= n; d++) {
    const ds = `${ym}-${pad(d)}`;
    const xs = byDay[ds] || [];
    const late = xs.some(x => !x.paid && !x.skipped && ds < t && !x.b.autopay);
    cells.push(`<div class="cd ${ds === t ? 'today' : ''} ${late ? 'late' : ''} ${xs.length ? 'has' : ''}" ${xs.length ? `title="${esc(xs.map(x => `${x.b.name}: ${money(x.b.amount)}${x.paid ? ' (paid)' : x.skipped ? ' (skipped)' : ''}`).join('\n'))}"` : ''}>
      <span class="dn">${d}</span>${xs.slice(0, 3).map(x => `<span class="cb ${x.paid || x.skipped ? 'paid' : ''}" style="--c:${catColor(x.b.category)}" data-bill="${esc(x.b.id)}">${esc(x.b.name)}</span>`).join('')}${xs.length > 3 ? `<span class="more">+${xs.length - 3}</span>` : ''}</div>`);
  }
  return `<div class="cal-head"><h2 style="margin:0;flex:1">${icon('calendar')}${esc(monthName(ym))}</h2>
      <button class="icon-btn" data-act="cal-prev" title="Previous month">${icon('chevron-left')}</button>
      ${ym !== monthOf(t) ? `<button class="btn sm ghost" data-act="cal-today">Today</button>` : ''}
      <button class="icon-btn" data-act="cal-next" title="Next month">${icon('chevron-right')}</button></div>
    <p class="desc" style="margin:4px 0 10px">${amt(total)} due this month in total.</p>
    <div class="cal">${wd.map(w => `<div class="wd">${esc(w)}</div>`).join('')}${cells.join('')}</div>`;
}

function categoryHtml(monthly) {
  const by = {};
  for (const b of S.bills || []) if (perMonth(b)) by[b.category] = (by[b.category] || 0) + perMonth(b);
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '<div class="muted">No active bills.</div>';
  const max = rows[0][1];
  return `<div class="hbars">${rows.map(([c, v]) => `<div class="hbar" title="${Math.round(v / monthly * 100)}% of your monthly total"><span>${esc(c)}</span>
    <div class="track"><div style="width:${Math.max(2, v / max * 100)}%;background:${catColor(c)}"></div></div><span class="num">${amt(v)}</span></div>`).join('')}</div>`;
}

function historyHtml(ym) {
  const months = [...Array(6)].map((_, i) => shiftMonth(ym, i - 5));
  const vals = months.map(m => sum((S.bills || []).flatMap(b => b.payments.filter(p => !p.skipped && paidMonth(p) === m).map(p => p.amount))));
  const max = Math.max(...vals, 1);
  if (!vals.some(Boolean)) return '<div class="muted">Mark bills paid and your monthly spend shows up here.</div>';
  return `<div class="hbars">${months.map((m, i) => `<div class="hbar"><span>${esc(monthName(m, false))}</span>
    <div class="track"><div style="width:${Math.max(vals[i] ? 2 : 0, vals[i] / max * 100)}%;background:var(--accent)"></div></div><span class="num">${amt(vals[i])}</span></div>`).join('')}</div>`;
}

function tableHtml(t) {
  const order = { overdue: 0, check: 1, today: 2, soon: 3, later: 4, paused: 5, done: 6 };
  const list = [...(S.bills || [])].map(b => ({ b, st: statusOf(b, t) }))
    .sort((x, y) => order[x.st.k] - order[y.st.k] || (x.b.dueDate || '').localeCompare(y.b.dueDate || '') || x.b.name.localeCompare(y.b.name));
  return `<div style="overflow-x:auto"><table class="ftbl bill-tbl"><thead><tr><th>Bill</th><th>How often</th><th class="num">Amount</th><th class="num">Per month</th><th>Next due</th><th>Last paid</th><th></th></tr></thead><tbody>
    ${list.map(({ b, st }) => {
      const last = b.payments.find(p => !p.skipped);
      return `<tr data-bill="${esc(b.id)}" data-act="edit" class="${b.paused || b.done ? 'dim' : ''}">
        <td><div class="nm">${billTile(b)}<div><div class="t">${esc(b.name)}</div><div class="p">${esc(b.category)}${b.last4 ? ` · ••${esc(b.last4)}` : ''}${b.autopay ? ' · auto-pay' : ''}</div></div></div></td>
        <td class="dt">${esc(FREQ[b.frequency]?.[0] || b.frequency)}</td>
        <td class="num">${amt(b.amount)}${b.variable ? '<span class="muted" title="Estimate"> ≈</span>' : ''}</td>
        <td class="num">${perMonth(b) ? amt(perMonth(b)) : '<span class="muted">-</span>'}</td>
        <td class="dt">${b.done ? 'Done' : b.paused ? 'Paused' : `${esc(niceDate(b.dueDate))} <span class="badge ${st.cls}">${esc(st.label.replace(/^Due /, ''))}</span>`}</td>
        <td class="dt">${last ? `${amt(last.amount)} <span class="muted">${esc(ui.timeAgo(last.paidAt))}</span>` : '<span class="muted">Not yet</span>'}</td>
        <td><div class="acts"><button class="icon-btn" data-act="menu" title="More">${icon('more')}</button></div></td></tr>`;
    }).join('')}</tbody>
    <tfoot><tr><td colspan="3"><b>Total</b></td><td class="num"><b>${amt(sum(list.map(x => perMonth(x.b))))}</b></td><td colspan="3" class="muted">per month</td></tr></tfoot></table></div>`;
}

function emptyHtml() {
  return `<div class="empty hero">
    <div class="tile xl" style="--c:#34d399">${icon('receipt')}</div>
    <h2>Keep every bill in sight</h2>
    <p>Add your bills once. DeskVault shows what's due next, what's late, and what this month costs in total, then moves each bill to its next due date when you mark it paid.</p>
    <div class="actions"><button class="btn primary" data-act="add">${icon('plus')}Add your first bill</button></div>
    <div class="quick-bills">${TEMPLATES.map(([n, c]) => `<button class="chip" data-act="template" data-name="${esc(n)}" data-cat="${esc(c)}"><span class="dot" style="background:${catColor(c)}"></span>${esc(n)}</button>`).join('')}</div>
    <div class="feature-row">
      <div class="feature"><b>${icon('calendar')}Due dates that move on</b>Mark a bill paid and it jumps to next month (or week, or year). Bills on the 31st stay on the last day of short months.</div>
      <div class="feature"><b>${icon('receipt')}A real monthly total</b>Weekly, quarterly and yearly bills are evened out so the monthly number is honest.</div>
      <div class="feature"><b>${icon('lock')}Private</b>Stays on this PC. Lock bills behind Windows Hello and blur amounts when sharing your screen.</div>
      <div class="feature"><b>${icon('bell')}Reminders</b>Optional Windows notifications a few days before each bill is due.</div>
    </div></div>`;
}

// ---------- editor ----------
function catOptions(cur) {
  const names = [...new Set([...Object.keys(CATS), ...(S.bills || []).map(b => b.category)])];
  return names.map(c => `<option value="${esc(c)}"></option>`).join('') + (cur && !names.includes(cur) ? `<option value="${esc(cur)}"></option>` : '');
}

export async function editBill(bill = null, preset = {}) {
  const b = bill || { frequency: 'monthly', remindDays: 3, category: 'Other', ...preset };
  const t = today();
  const res = await ui.modal({
    title: bill ? `Edit ${bill.name}` : 'Add a bill',
    body: `<div class="form-grid bill-form">
        <div class="field"><label>Name</label><input class="input" name="name" maxlength="80" value="${esc(b.name || '')}" placeholder="Electric, Rent, Phone…" ${b.name ? '' : 'autofocus'}></div>
        <div class="field"><label>Amount</label><input class="input" name="amount" inputmode="decimal" value="${b.amount != null ? esc(b.amount.toFixed(2)) : ''}" placeholder="0.00" ${b.name ? 'autofocus' : ''}></div>
        <div class="field"><label>How often</label><select class="input" name="frequency">${Object.entries(FREQ).map(([k, [l]]) => `<option value="${k}" ${b.frequency === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>Next due date</label><input class="input" type="date" name="dueDate" value="${esc(b.dueDate || '')}" min="2000-01-01" max="2200-12-31"></div>
        <div class="field"><label>Category</label><input class="input" name="category" maxlength="30" list="billCats" value="${esc(b.category || 'Other')}"><datalist id="billCats">${catOptions(b.category)}</datalist></div>
        <div class="field"><label>Remind me</label><select class="input" name="remindDays">${[[0, 'On the day'], [1, '1 day before'], [3, '3 days before'], [5, '5 days before'], [7, 'A week before'], [14, '2 weeks before']].map(([v, l]) => `<option value="${v}" ${(b.remindDays ?? 3) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="row-field" style="margin-top:10px"><div class="grow"><div class="t">Amount changes each time</div><div class="d">Like electric or a credit card. The amount is an estimate and updates to whatever you last paid.</div></div><input type="checkbox" class="switch" name="variable" ${b.variable ? 'checked' : ''}></div>
      <div class="row-field"><div class="grow"><div class="t">${icon('zap')} Auto-pay is on</div><div class="d">It pays itself. When the date passes, DeskVault asks you to confirm it went through instead of calling it late.</div></div><input type="checkbox" class="switch" name="autopay" ${b.autopay ? 'checked' : ''}></div>
      ${bill ? `<div class="row-field"><div class="grow"><div class="t">Paused</div><div class="d">Keeps the bill and its history, but leaves it out of totals and reminders.</div></div><input type="checkbox" class="switch" name="paused" ${b.paused ? 'checked' : ''}></div>` : ''}
      <div class="form-grid bill-form" style="margin-top:6px">
        <div class="field"><label>Payment website <span class="muted">(optional)</span></label><input class="input" name="payUrl" maxlength="500" value="${esc(b.payUrl || '')}" placeholder="https://…"></div>
        <div class="field"><label>Account or card, last 4 <span class="muted">(optional)</span></label><input class="input" name="last4" maxlength="4" inputmode="numeric" autocomplete="off" value="${esc(b.last4 || '')}" placeholder="1234"></div>
      </div>
      <div class="field"><label>Notes <span class="muted">(optional)</span></label><textarea class="input" name="notes" rows="2" maxlength="1000" placeholder="Account holder, how to pay, phone number…">${esc(b.notes || '')}</textarea>
        <div class="hint">${icon('shield')} Never put full card numbers, passwords or PINs here. DeskVault only keeps the last 4 digits on purpose.</div></div>`,
    actions: [
      ...(bill ? [{ label: 'Delete', kind: 'ghost', left: true, icon: 'trash', onClick: async (m, close) => { close(null); await removeBill(bill); return false; } }] : []),
      { label: 'Cancel', value: null },
      {
        label: bill ? 'Save' : 'Add bill', kind: 'primary', onClick: async m => {
          const f = n => m.querySelector(`[name=${n}]`);
          const data = {
            id: bill?.id, name: f('name').value, amount: f('amount').value || '0', frequency: f('frequency').value, dueDate: f('dueDate').value,
            category: f('category').value, remindDays: +f('remindDays').value, variable: f('variable').checked, autopay: f('autopay').checked,
            paused: f('paused')?.checked || false, payUrl: f('payUrl').value, last4: f('last4').value, notes: f('notes').value,
          };
          if (!data.dueDate) throw new Error('Pick the next due date');
          if (!bill && data.dueDate < t && !(await ui.confirm({ title: 'That date has passed', message: `${niceDate(data.dueDate)} is in the past, so this bill starts out late. Is that right? (If it's already paid, pick the next due date instead.)`, confirmLabel: 'Yes, it\'s late' }))) return false;
          return post('/api/bills/save', { bill: data });
        },
      },
    ],
  });
  if (res) { ui.toast(bill ? 'Saved' : `Added ${res.name}`, { type: 'ok', timeout: 2000 }); await refresh(); }
  return res;
}

async function removeBill(b) {
  const ok = await ui.confirm({ title: `Delete ${b.name}?`, message: `This removes the bill and its ${b.payments.length} payment record${b.payments.length === 1 ? '' : 's'}. Pausing it keeps the history instead.`, confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try { await post('/api/bills/remove', { id: b.id }); ui.toast(`Deleted ${b.name}`, { type: 'ok', timeout: 2500 }); refresh(); }
  catch (e) { ui.toast(e.message, { type: 'error' }); }
}

// ---------- paying ----------
async function quickPay(b) {
  if (b.variable) return payWithDetails(b);
  return doPay(b, {});
}

async function doPay(b, extra) {
  try {
    const r = await post('/api/bills/pay', { id: b.id, ...extra });
    const next = r.done ? 'Paid off, no more due.' : `Next due ${niceDate(r.dueDate)}.`;
    ui.toast(`${b.name} marked paid. ${next}`, { type: 'ok', timeout: 7000, action: () => undoPay(b), actionLabel: 'Undo' });
    await refresh();
  } catch (e) { ui.toast(e.message, { type: 'error' }); }
}

async function payWithDetails(b) {
  const r = await ui.modal({
    title: `Mark ${b.name} paid`,
    body: `<p class="muted" style="margin-top:0">For the one due ${esc(niceDate(b.dueDate))}.</p><div class="form-grid bill-form">
      <div class="field"><label>Amount paid</label><input class="input" name="amount" inputmode="decimal" value="${esc(b.amount.toFixed(2))}" autofocus></div>
      <div class="field"><label>Paid on</label><input class="input" type="date" name="date" value="${today()}" max="${today()}"></div></div>
      <div class="field"><label>Note <span class="muted">(optional)</span></label><input class="input" name="note" maxlength="200" placeholder="Confirmation number…"></div>`,
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Mark paid', kind: 'primary', icon: 'check',
      onClick: m => ({ amount: m.querySelector('[name=amount]').value, date: m.querySelector('[name=date]').value, note: m.querySelector('[name=note]').value }),
    }],
  });
  if (r) await doPay(b, r);
}

async function undoPay(b) {
  try { await post('/api/bills/undo', { id: b.id }); ui.toast(`Undone. ${b.name} is due again`, { type: 'ok', timeout: 2500 }); refresh(); }
  catch (e) { ui.toast(e.message, { type: 'error' }); }
}

async function skip(b) {
  const ok = await ui.confirm({ title: `Skip ${b.name} this time?`, message: `Nothing is owed for the one due ${niceDate(b.dueDate)} (a free month, a credit, or it was paid some other way). It moves on to the next due date without recording a payment.`, confirmLabel: 'Skip it' });
  if (!ok) return;
  try { await post('/api/bills/skip', { id: b.id }); ui.toast(`Skipped. ${b.name} moves to its next due date`, { type: 'ok', timeout: 6000, action: () => undoPay(b), actionLabel: 'Undo' }); refresh(); }
  catch (e) { ui.toast(e.message, { type: 'error' }); }
}

function historyModal(b) {
  const rows = b.payments.slice(0, 60);
  ui.modal({
    title: `${b.name}: payment history`, wide: true,
    body: rows.length ? `<table class="ftbl"><thead><tr><th>Was due</th><th>Paid</th><th class="num">Amount</th><th>Note</th></tr></thead><tbody>
      ${rows.map(p => `<tr><td class="dt">${esc(niceDate(p.dueDate))}</td><td class="dt">${p.skipped ? '<span class="badge muted">Skipped</span>' : esc(ui.fmtDate(p.paidAt, false))}${!p.skipped && ymdLocal(new Date(p.paidAt)) > p.dueDate ? ' <span class="badge warn">late</span>' : ''}</td>
        <td class="num">${p.skipped ? '-' : amt(p.amount)}</td><td>${esc(p.note || '')}</td></tr>`).join('')}</tbody></table>
      <p class="muted" style="font-size:12.5px">${amt(sum(b.payments.filter(p => !p.skipped && p.paidAt.slice(0, 4) === today().slice(0, 4)).map(p => p.amount)))} paid this year.</p>`
      : '<p class="muted">No payments recorded yet.</p>',
    actions: [{ label: 'Close', kind: 'primary', value: null }],
  });
}

function billMenu(b) {
  const can = active(b);
  return [
    can && { label: b.autopay && statusOf(b).k === 'check' ? 'It went through' : 'Mark paid', icon: 'check', onClick: () => quickPay(b) },
    can && { label: 'Mark paid with amount / date…', icon: 'edit', onClick: () => payWithDetails(b) },
    can && { label: 'Skip this one', icon: 'skip', onClick: () => skip(b) },
    b.payments.length && { label: 'Undo last payment', icon: 'undo', onClick: () => undoPay(b) },
    { divider: true },
    b.payUrl && { label: 'Open payment site', icon: 'external', onClick: () => window.open(b.payUrl, '_blank', 'noopener,noreferrer') },
    { label: 'Payment history', icon: 'history', onClick: () => historyModal(b) },
    { label: 'Edit…', icon: 'edit', onClick: () => editBill(b) },
    { label: b.paused ? 'Resume' : 'Pause', icon: b.paused ? 'refresh' : 'clock', onClick: () => post('/api/bills/save', { bill: { ...b, paused: !b.paused } }).then(refresh, e => ui.toast(e.message, { type: 'error' })) },
    { label: 'Delete…', icon: 'trash', danger: true, onClick: () => removeBill(b) },
  ].filter(Boolean);
}

// ---------- settings / export ----------
async function billSettings() {
  const L = S.app.lock || {};
  const notif = typeof Notification !== 'undefined';
  await ui.modal({
    title: 'Bill settings',
    body: `<div class="row-field"><div class="grow"><div class="t">Currency</div></div>
        <select class="input" name="cur">${CURRENCIES.map(c => `<option ${(S.settings.billCurrency || 'USD') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="row-field"><div class="grow"><div class="t">${icon('bell')} Windows notifications</div><div class="d">${notif ? 'Pops up when a bill is coming up (based on each bill\'s "Remind me"), due today or late, while DeskVault is open in your browser.' : 'This browser doesn\'t support notifications.'}${notif && Notification.permission === 'denied' ? '<br><b>Blocked in this browser.</b> Allow notifications for this site in the address bar first.' : ''}</div></div>
        <input type="checkbox" class="switch" name="notify" ${load('billsNotify', '0') === '1' && notif && Notification.permission === 'granted' ? 'checked' : ''} ${notif ? '' : 'disabled'}></div>
      <div class="row-field"><div class="grow"><div class="t">${icon('lock')} Lock bills with Windows Hello</div><div class="d">Hides every name, amount and date until you unlock with your PIN, fingerprint or face. Locks again after ${L.minutes || 5} idle minutes.${L.hello && L.hello !== 'Available' ? `<br><b>${esc(L.help || 'Windows Hello isn\'t available.')}</b>` : ''}</div></div>
        <input type="checkbox" class="switch" name="lock" ${L.bills ? 'checked' : ''}></div>
      <p class="muted" style="font-size:12.5px;margin-bottom:0">${icon('shield')} Bills live in DeskVault's library on this PC and go into your backups with it. Nothing is sent anywhere.</p>`,
    actions: [{ label: 'Done', kind: 'primary', value: null }],
    onOpen: m => {
      m.querySelector('[name=cur]').addEventListener('change', async e => {
        await post('/api/settings', { patch: { billCurrency: e.target.value } }).catch(err => ui.toast(err.message, { type: 'error' }));
        refresh();
      });
      m.querySelector('[name=notify]').addEventListener('change', async e => {
        if (e.target.checked) {
          const p = await Notification.requestPermission();
          if (p !== 'granted') { e.target.checked = false; ui.toast('Notifications were not allowed', { type: 'warn' }); return; }
          save('billsNotify', '1');
          new Notification('DeskVault bill reminders are on', { body: 'You\'ll get a heads-up before bills are due.', icon: '/favicon.svg', tag: 'vault-bills-on' });
          checkReminders(true);
        } else save('billsNotify', '0');
      });
      m.querySelector('[name=lock]').addEventListener('change', async e => {
        const want = e.target.checked;
        const done = await setLock({ bills: true, locked: want });
        if (!done) e.target.checked = !want;
      });
    },
  });
}

function exportCsv() {
  // Prefix cells that a spreadsheet would treat as a formula (CSV injection).
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const line = a => a.map(cell).join(',');
  const out = [line(['Bill', 'Category', 'How often', 'Amount', 'Per month', 'Next due', 'Auto-pay', 'Status', 'Payment', 'Was due', 'Paid on', 'Paid amount', 'Note'])];
  for (const b of S.bills || []) {
    const base = [b.name, b.category, FREQ[b.frequency]?.[0], b.amount.toFixed(2), perMonth(b).toFixed(2), b.done ? '' : b.dueDate, b.autopay ? 'yes' : 'no', statusOf(b).label];
    out.push(line([...base, 'current', '', '', '', '']));
    for (const p of b.payments) out.push(line([...base, p.skipped ? 'skipped' : 'paid', p.dueDate, p.skipped ? '' : ymdLocal(new Date(p.paidAt)), p.skipped ? '' : p.amount.toFixed(2), p.note || '']));
  }
  const url = URL.createObjectURL(new Blob(['﻿' + out.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `bills-${today()}.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  ui.toast('Exported. The file has your bills and payment history', { type: 'ok' });
}

// ---------- reminders ----------
let toastedThisSession = false;
/** Called after every refresh and once a minute: in-app nudge once per session, Windows notification once per bill per day. */
export function checkReminders(force = false) {
  const bills = S.bills || [];
  if (!bills.length) return;
  const t = today();
  const due = bills.map(b => ({ b, st: statusOf(b, t) })).filter(({ b, st }) => st.k === 'overdue' || st.k === 'check' || (!b.autopay && (st.k === 'today' || st.k === 'soon')));
  if (!toastedThisSession && parseHash().name !== 'bills') {
    const urgent = due.filter(x => x.st.k === 'overdue' || x.st.k === 'today');
    if (urgent.length) {
      toastedThisSession = true;
      const late = urgent.filter(x => x.st.k === 'overdue').length;
      ui.toast(late ? `${late} bill${late > 1 ? 's are' : ' is'} late${urgent.length > late ? `, ${urgent.length - late} due today` : ''}` : `${urgent.length} bill${urgent.length > 1 ? 's' : ''} due today`,
        { type: late ? 'warn' : 'info', timeout: 12000, action: () => { location.hash = '#/bills'; }, actionLabel: 'Show' });
    }
  }
  if (load('billsNotify', '0') !== '1' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  let sent = {};
  try { sent = JSON.parse(load('billsNotified', '{}')) || {}; } catch {}
  for (const k of Object.keys(sent)) if (sent[k] !== t) delete sent[k];
  for (const { b, st } of due) {
    const key = `${b.id}:${b.dueDate}:${st.k}`;
    if (sent[key] && !force) continue;
    sent[key] = t;
    const n = new Notification(st.k === 'overdue' ? `Late: ${b.name}` : `${b.name}: ${st.label.toLowerCase()}`, {
      body: `${money(b.amount)}${b.variable ? ' (about)' : ''} · due ${niceDate(b.dueDate)}`, icon: '/favicon.svg', tag: 'vault-bill-' + b.id,
    });
    n.onclick = () => { window.focus(); location.hash = '#/bills'; n.close(); };
  }
  save('billsNotified', JSON.stringify(sent));
}

// ---------- events ----------
const billOf = el => { const id = el?.closest('[data-bill]')?.dataset.bill; return id && (S.bills || []).find(b => b.id === id); };

document.addEventListener('click', async e => {
  const el = host();
  if (!el || !el.contains(e.target)) return;
  const a = e.target.closest('[data-act]');
  const b = billOf(e.target);
  if (!a) { if (b && e.target.closest('.cb')) ui.menu(e.target.closest('.cb'), billMenu(b)); return; }
  switch (a.dataset.act) {
    case 'unlock': return unlock();
    case 'lock-now': return lockNow();
    case 'add': return editBill();
    case 'template': return editBill(null, { name: a.dataset.name, category: a.dataset.cat });
    case 'settings': return billSettings();
    case 'export': return exportCsv();
    case 'privacy': {
      const on = !document.body.classList.contains('bills-private');
      document.body.classList.toggle('bills-private', on);
      save('billsHide', on ? '1' : '0');
      return draw();
    }
    case 'cal-prev': B.month = shiftMonth(B.month, -1); return draw();
    case 'cal-next': B.month = shiftMonth(B.month, 1); return draw();
    case 'cal-today': B.month = monthOf(today()); return draw();
    case 'pay': if (b) { a.disabled = true; await quickPay(b); a.disabled = false; } return;
    case 'menu': if (b) ui.menu(a, billMenu(b), { align: 'right' }); return;
    case 'edit': if (b && !e.target.closest('button, a')) editBill(b); return;
  }
});

document.addEventListener('contextmenu', e => {
  const el = host();
  if (!el || !el.contains(e.target)) return;
  const b = billOf(e.target);
  if (!b) return;
  e.preventDefault();
  ui.menu({ x: e.clientX, y: e.clientY }, billMenu(b));
});
