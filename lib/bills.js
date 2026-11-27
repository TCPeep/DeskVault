// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Bills: recurring payments with a next due date. Each bill stores only its *next unpaid* due date;
// marking it paid records a payment and moves the date forward one period. Everything is validated
// here so the browser can never write odd shapes into library.json.
//
// Deliberately NOT stored: full card/account numbers, passwords, PINs. Only the last 4 digits, so
// a backup drive or a peek at library.json never gives anything away that could be used to pay.
import { newId } from './store.js';

export const FREQS = ['weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'yearly', 'once'];
const MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };
const MAX_PAYMENTS = 150;
const MAX_BILLS = 500;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function validDate(s) {
  const m = DATE_RE.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  if (+m[1] < 2000 || +m[1] > 2200) return null;
  return s;
}
const ymd = d => d.toISOString().slice(0, 10);
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Next due date after `date`. Month-based bills keep their day (a bill due on the 31st is due
 *  Feb 28/29, then Mar 31 again) instead of drifting earlier every short month. */
export function advance(date, freq, anchorDay) {
  const [y, m, d] = date.split('-').map(Number);
  if (freq === 'weekly' || freq === 'biweekly') return ymd(new Date(Date.UTC(y, m - 1, d + (freq === 'weekly' ? 7 : 14))));
  const add = MONTHS[freq];
  if (!add) return null; // one-off
  const t = m - 1 + add, ny = y + Math.floor(t / 12), nm = ((t % 12) + 12) % 12;
  return ymd(new Date(Date.UTC(ny, nm, Math.min(anchorDay || d, daysIn(ny, nm)))));
}

function money(v, { allowZero = true } = {}) {
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.\-]/g, '')) : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new Error('Enter an amount like 84.20');
  if (!allowZero && n === 0) throw new Error('Enter an amount like 84.20');
  return Math.round(n * 100) / 100;
}
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function payUrl(v) {
  const s = text(v, 500);
  if (!s) return '';
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s); } catch { throw new Error('The payment link doesn\'t look right'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('The payment link must be a web address');
  if (u.username || u.password) throw new Error('Leave logins out of the payment link');
  return u.href;
}

function last4(v) {
  const s = String(v ?? '').replace(/\D/g, '');
  if (!s) return '';
  if (s.length > 4) throw new Error('Only keep the last 4 digits of an account or card here, never the full number');
  return s;
}

/** Build a clean bill from browser input. `prev` is the existing bill when editing. */
export function cleanBill(input, prev = null) {
  const b = input || {};
  const name = text(b.name, 80);
  if (!name) throw new Error('Give the bill a name');
  const frequency = FREQS.includes(b.frequency) ? b.frequency : 'monthly';
  const dueDate = validDate(b.dueDate);
  if (!dueDate && !prev?.done) throw new Error('Pick the next due date');
  const at = new Date().toISOString();
  return {
    id: prev?.id || newId(),
    name,
    amount: money(b.amount),
    variable: !!b.variable,
    category: text(b.category, 30) || 'Other',
    frequency,
    dueDate: dueDate || prev?.dueDate || null,
    // Remember the intended day of month; only reset it when the due date is changed by hand.
    anchorDay: dueDate && dueDate !== prev?.dueDate ? Number(dueDate.slice(8)) : (prev?.anchorDay || Number((dueDate || '').slice(8)) || 1),
    autopay: !!b.autopay,
    payUrl: payUrl(b.payUrl),
    last4: last4(b.last4),
    notes: text(b.notes, 1000),
    remindDays: Math.max(0, Math.min(30, Math.round(Number(b.remindDays ?? 3)) || 0)),
    paused: !!b.paused,
    done: prev?.done && !(dueDate && dueDate !== prev?.dueDate) ? true : false,
    payments: prev?.payments || [],
    createdAt: prev?.createdAt || at,
    updatedAt: at,
  };
}

export class Bills {
  constructor({ store, emit }) {
    this.store = store;
    this.emit = emit;
  }

  get list() { return this.store.data.bills; }
  byId(id) {
    const b = this.list.find(x => x.id === id);
    if (!b) throw Object.assign(new Error('No such bill'), { status: 404 });
    return b;
  }

  changed(message) {
    this.store.log('bill', message);
    this.store.save();
    this.emit('bills');
  }

  save(input) {
    if (input?.id) {
      const prev = this.byId(input.id);
      const next = cleanBill(input, prev);
      Object.assign(prev, next);
      this.changed(`Updated bill ${prev.name}`);
      return prev;
    }
    if (this.list.length >= MAX_BILLS) throw new Error(`That's ${MAX_BILLS} bills already`);
    const bill = cleanBill(input);
    this.list.push(bill);
    this.changed(`Added bill ${bill.name}`);
    return bill;
  }

  remove(id) {
    const b = this.byId(id);
    this.store.data.bills = this.list.filter(x => x !== b);
    this.changed(`Deleted bill ${b.name}`);
    return { ok: true };
  }

  /** Record the current due date as paid (or skipped) and move on to the next one. */
  pay(id, { amount, date, skip = false, note } = {}) {
    const b = this.byId(id);
    if (b.done || !b.dueDate) throw new Error('This bill has nothing due');
    const paidOn = validDate(date) || null;
    const entry = {
      id: newId(), dueDate: b.dueDate, paidAt: paidOn ? paidOn + 'T12:00:00.000Z' : new Date().toISOString(),
      amount: skip ? 0 : (amount === undefined || amount === '' || amount === null ? b.amount : money(amount)),
      skipped: !!skip, note: text(note, 200),
    };
    b.payments.unshift(entry);
    if (b.payments.length > MAX_PAYMENTS) b.payments.length = MAX_PAYMENTS;
    // A variable bill remembers what it really cost, so the next estimate is closer.
    if (!skip && b.variable && entry.amount > 0) b.amount = entry.amount;
    const next = advance(b.dueDate, b.frequency, b.anchorDay);
    if (next) b.dueDate = next; else b.done = true;
    b.updatedAt = new Date().toISOString();
    this.changed(skip ? `Skipped ${b.name} due ${entry.dueDate}` : `Paid ${b.name}`);
    return b;
  }

  /** Undo the most recent payment/skip: its due date becomes the next one again. */
  undo(id) {
    const b = this.byId(id);
    const last = b.payments.shift();
    if (!last) throw new Error('Nothing to undo');
    b.dueDate = last.dueDate;
    b.done = false;
    b.updatedAt = new Date().toISOString();
    this.changed(`Undid the last payment on ${b.name}`);
    return b;
  }
}
