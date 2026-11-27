// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Bills API test against a throwaway server (never touches real data).  node test/bills.mjs [dataDir]
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.argv[2] || path.join(os.tmpdir(), `vault-bills-test-${Date.now()}`));
fs.rmSync(DATA, { recursive: true, force: true });
const PORT = 4491, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(APP, 'server.js'), '--port', String(PORT), '--data', DATA], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, body, { expect = 200, headers = {} } = {}) {
  const r = await fetch(BASE + p, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, ...headers }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  assert.equal(r.status, expect, `${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}
for (let i = 0; i < 150; i++) { try { await api('/api/ping'); break; } catch { await sleep(200); } }
try {
  const st = await api('/api/state');
  assert.deepEqual(st.bills, []);
  const rent = await api('/api/bills/save', { bill: { name: 'Rent', amount: '1,250.00', frequency: 'monthly', dueDate: '2026-01-31', category: 'Housing' } });
  assert.equal(rent.amount, 1250); assert.equal(rent.anchorDay, 31);
  let r = await api('/api/bills/pay', { id: rent.id }); assert.equal(r.dueDate, '2026-02-28');
  r = await api('/api/bills/pay', { id: rent.id }); assert.equal(r.dueDate, '2026-03-31');
  r = await api('/api/bills/undo', { id: rent.id }); assert.equal(r.dueDate, '2026-02-28'); assert.equal(r.payments.length, 1);
  r = await api('/api/bills/skip', { id: rent.id }); assert.equal(r.dueDate, '2026-03-31'); assert.equal(r.payments[0].skipped, true); assert.equal(r.payments[0].amount, 0);
  await api('/api/bills/save', { bill: { name: 'Insurance', amount: 600, frequency: 'yearly', dueDate: '2027-02-28' } });
  const lp = await api('/api/bills/save', { bill: { name: 'Leap', amount: 1, frequency: 'yearly', dueDate: '2028-02-29' } });
  r = await api('/api/bills/pay', { id: lp.id }); assert.equal(r.dueDate, '2029-02-28');
  r = await api('/api/bills/pay', { id: lp.id }); assert.equal(r.dueDate, '2030-02-28');
  const wk = await api('/api/bills/save', { bill: { name: 'Daycare', amount: 200, frequency: 'biweekly', dueDate: '2026-12-28' } });
  r = await api('/api/bills/pay', { id: wk.id }); assert.equal(r.dueDate, '2027-01-11');
  const el = await api('/api/bills/save', { bill: { name: 'Electric', amount: 80, variable: true, frequency: 'monthly', dueDate: '2026-11-15' } });
  r = await api('/api/bills/pay', { id: el.id, amount: '93.47', date: '2026-11-20', note: 'conf 123' });
  assert.equal(r.amount, 93.47); assert.equal(r.payments[0].paidAt, '2026-11-20T12:00:00.000Z'); assert.equal(r.dueDate, '2026-12-15');
  const once = await api('/api/bills/save', { bill: { name: 'Vet', amount: 300, frequency: 'once', dueDate: '2026-12-01' } });
  r = await api('/api/bills/pay', { id: once.id }); assert.equal(r.done, true);
  await api('/api/bills/pay', { id: once.id }, { expect: 400 });
  r = await api('/api/bills/undo', { id: once.id }); assert.equal(r.done, false);
  const cur = (await api('/api/state')).bills.find(b => b.id === rent.id);
  r = await api('/api/bills/save', { bill: { ...cur, name: 'Rent (apt)' } });
  assert.equal(r.name, 'Rent (apt)'); assert.equal(r.anchorDay, 31); assert.equal(r.payments.length, 2);
  await api('/api/bills/save', { bill: { name: '', amount: 1, dueDate: '2026-12-01' } }, { expect: 400 });
  await api('/api/bills/save', { bill: { name: 'x', amount: -5, dueDate: '2026-12-01' } }, { expect: 400 });
  await api('/api/bills/save', { bill: { name: 'x', amount: 5, dueDate: '2026-02-30' } }, { expect: 400 });
  await api('/api/bills/save', { bill: { name: 'x', amount: 5, dueDate: '2026-12-01', last4: '4111111111111111' } }, { expect: 400 });
  await api('/api/bills/save', { bill: { name: 'x', amount: 5, dueDate: '2026-12-01', payUrl: 'javascript:alert(1)' } }, { expect: 400 });
  await api('/api/bills/save', { bill: { name: 'x', amount: 5, dueDate: '2026-12-01', payUrl: 'https://user:pw@bank.com' } }, { expect: 400 });
  const ok = await api('/api/bills/save', { bill: { name: '<img src=x onerror=alert(1)>', amount: 5, dueDate: '2026-12-01', payUrl: 'mybank.com/pay', last4: '12-34', frequency: 'bogus', remindDays: 999, extra: 'ignored' } });
  assert.equal(ok.payUrl, 'https://mybank.com/pay'); assert.equal(ok.last4, '1234'); assert.equal(ok.frequency, 'monthly'); assert.equal(ok.remindDays, 30); assert.equal(ok.extra, undefined);
  await api('/api/bills/pay', { id: 'nope' }, { expect: 404 });
  await api('/api/bills/save', { bill: { name: 'evil', amount: 1, dueDate: '2026-12-01' } }, { expect: 403, headers: { Origin: 'http://evil.example' } });
  const ct = await fetch(BASE + '/api/bills/remove', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: BASE }, body: JSON.stringify({ id: rent.id }) });
  assert.equal(ct.status, 403);
  await api('/api/bills/remove', { id: ok.id });
  let s2 = await api('/api/settings', { patch: { billCurrency: 'EUR' } }); assert.equal(s2.billCurrency, 'EUR');
  s2 = await api('/api/settings', { patch: { billCurrency: 'evil<' } }); assert.equal(s2.billCurrency, 'EUR');
  const act = await api('/api/activity'); assert.ok(act.some(a => a.type === 'bill' && /Paid Rent/.test(a.message)));
  await sleep(400);
  const lib = JSON.parse(fs.readFileSync(path.join(DATA, 'library.json'), 'utf8'));
  assert.equal(lib.bills.length, 6);
  await sleep(1500); // let the Windows Hello availability check finish
  const set = await fetch(BASE + '/api/lock/set', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ bills: true, locked: true }) });
  console.log('lock/set ->', set.status, JSON.stringify(await set.json()));
  if (set.status === 200) {
    const ls = await api('/api/state');
    assert.deepEqual(ls.bills, []); assert.equal(ls.app.lock.bills, true); assert.equal(ls.app.lock.any, true);
    await api('/api/bills/pay', { id: rent.id }, { expect: 423 });
    await api('/api/bills/save', { bill: { name: 'x', amount: 1, dueDate: '2026-12-01' } }, { expect: 423 });
    const la = await api('/api/activity'); assert.ok(la.filter(a => a.type === 'bill').every(a => a.message === 'Something changed in your locked bills'));
    await api('/api/lock/set', { bills: true, locked: false }, { expect: 423 });
    console.log('lock redaction OK');
  }
  console.log('ALL BILL API TESTS PASSED');
} catch (e) { console.error('FAIL', e); console.error(out.slice(-2000)); process.exitCode = 1; }
finally { srv.kill(); fs.rmSync(DATA, { recursive: true, force: true }); }
