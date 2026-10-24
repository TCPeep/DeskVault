// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Reinstall page: is everything that a Windows reinstall would wipe safely backed up?
import { S, refresh, parseHash, go } from './state.js';
import { get, post } from './api.js';
import * as ui from './ui.js';
const { esc, icon } = ui;

const R = { page: null, data: null, picked: new Set() };
const host = () => (parseHash().name === 'reinstall' ? R.page?.querySelector('#rin') : null);

export async function renderReinstall(page) {
  R.page = page;
  page.innerHTML = `<div id="rin"><div class="page-head"><h1>Reinstall</h1></div><div class="loading">${icon('loader', 'spin')}Checking what's backed up…</div></div>`;
  try { R.data = await get('/api/reinstall'); } catch (e) { host().innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  // Pre-tick the small settings-type places; big personal folders (Desktop, Documents…) are the user's call.
  const BIG = ['desktop', 'documents', 'pictures', 'videos', 'music', 'downloads'];
  R.picked = new Set(R.data.candidates.filter(c => !c.inVault && c.onSystemDrive && !BIG.includes(c.id)).map(c => c.id));
  draw();
}

function row(state, title, desc, action = '', extra = '') {
  const ic = { ok: 'check', warn: 'alert', bad: 'x' }[state];
  const label = { ok: 'Done', warn: 'Needs a look', bad: 'Not yet' }[state];
  return `<div class="check-row"><div class="st ${state}" title="${label}" aria-label="${label}">${icon(ic)}</div>
    <div><div class="t">${title}</div><div class="d">${desc}</div>${extra}</div><div>${action}</div></div>`;
}

function draw() {
  const el = host();
  if (!el) return;
  const d = R.data, sys = d.systemDrive;
  const latest = d.latest;
  const atRisk = d.items.filter(i => !i.backedUpAt);
  const stale = d.items.filter(i => i.changedSince);
  const forgotten = d.candidates.filter(c => !c.inVault && c.onSystemDrive);
  const goBackup = `<button class="btn sm" data-act="backups">${icon('backup')}Back up now</button>`;

  const checks = [
    latest
      ? row('ok', `Backed up to ${esc(latest.dest)}`, `Latest backup ${esc(ui.timeAgo(latest.at))} (${latest.mode === 'mirror' ? 'mirror' : 'snapshot'}). It's on a different drive than Windows, so a reinstall won't touch it.`, goBackup)
      : row('bad', 'No backup on another drive yet', `A reinstall wipes ${esc(sys)}. Back up to another drive (D: or a USB drive) first.`, goBackup),
    d.items.length === 0
      ? row('warn', `Nothing on ${esc(sys)} is in Vault yet`, 'Add the folders you care about (see the list below), then back up.')
      : atRisk.length || stale.length
        ? row('warn', `${d.items.length - atRisk.length} of ${d.items.length} things on ${esc(sys)} are backed up`,
            `${atRisk.length ? `${atRisk.length} ${atRisk.length === 1 ? 'hasn\'t' : 'haven\'t'} been backed up yet.` : ''} ${stale.length ? `${stale.length} changed since the last backup.` : ''}`.trim(), goBackup,
            `<details><summary>Show which</summary><div class="list-plain" style="margin-top:6px">${[...atRisk, ...stale].slice(0, 30).map(i => `<div class="li">${ui.tile({ kind: i.kind, path: i.path, name: i.name, hidden: i.hidden })}<span>${esc(i.name)}</span><span class="mono">${esc(i.path)}</span><span class="badge ${i.backedUpAt ? 'info' : 'warn'}">${i.backedUpAt ? 'changed since' : 'not backed up'}</span></div>`).join('')}</div></details>`)
        : row('ok', `All ${d.items.length} things on ${esc(sys)} are backed up`, 'Every file and folder Vault tracks on the Windows drive is in your latest backup.'),
    d.appsSaved
      ? row('ok', 'Your app list is saved', `Saved with the latest backup, in <span class="mono">_This PC</span>. After reinstalling, one command reinstalls most of your apps (steps are in the file).`)
      : row('bad', 'Your app list isn\'t saved yet', 'Vault saves the list of installed programs (plus a winget file that reinstalls most of them) with every backup.', goBackup),
    d.vaultApp
      ? row('ok', 'Vault itself is on the backup drive', `A ready-to-run copy (Node.js included) is in <span class="mono">${esc(d.vaultAppPath)}</span>. After reinstalling, open it from there.`)
      : row('bad', 'Vault itself isn\'t on the backup drive yet', `Vault lives on ${esc(sys)} right now${d.appOnSystemDrive ? '' : ''}. Every backup copies a runnable Vault onto the backup drive.`, goBackup),
    row('ok', `${d.linksAndNotes} link${d.linksAndNotes === 1 ? '' : 's'} and note${d.linksAndNotes === 1 ? '' : 's'} are safe`, 'Your links, notes, tags and collections are saved inside every backup.'),
  ];

  el.innerHTML = `
    <div class="page-head"><h1>Reinstall</h1><span class="sub">Get Windows reinstalled without losing anything</span></div>
    <div class="panels">
      <section class="panel"><h2>${icon('shield')}Ready for a reinstall?</h2>
        <p class="desc">Reinstalling Windows erases ${esc(sys)}. Your other drives (${esc(['D:', 'E:'].filter(x => x !== sys).join(', '))} etc.) are left alone.</p>
        <div class="checklist">${checks.join('')}</div></section>
      <section class="panel"><h2>${icon('lifebuoy')}After reinstalling</h2>
        <ol class="steps">
          <li>Plug in your backup drive and open <b>Vault Backups → Vault app</b>. Double-click <b>Start Vault.cmd</b>. Nothing needs installing.</li>
          <li>Come back to this page and press <b>Restore everything</b>. Files go back where they were. If your Windows user name changed, they go into your new user folder. Nothing is overwritten.</li>
          <li>Open <b>_This PC</b> inside the newest backup and follow <b>HOW TO REINSTALL APPS.txt</b>. One command brings back most programs.</li>
          <li>Copy the <b>Vault app</b> folder somewhere permanent (another drive is best) and turn on <i>Start with Windows</i> in Settings.</li>
        </ol>
        <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <button class="btn primary" data-act="restore-all" ${latest ? '' : 'disabled'}>${icon('history')}Restore everything</button>
          <span class="muted" style="font-size:12.5px">${latest ? `from the backup ${esc(ui.timeAgo(latest.at))} on ${esc(latest.dest)}` : 'Needs a backup first'}</span>
        </div></section>
    </div>
    <section class="panel"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="flex:1;margin:0">${icon('sparkle')}Easy to forget</h2>
        ${forgotten.length ? `<button class="btn primary sm" data-act="add-picked" ${R.picked.size ? '' : 'disabled'}>${icon('plus')}Add ${R.picked.size || ''} to Vault</button>` : ''}</div>
      <p class="desc" style="margin-top:6px">Places on ${esc(sys)} people often lose in a reinstall. Adding them to Vault puts them in every backup (in a "Reinstall kit" collection).</p>
      ${d.candidates.map(c => {
        const status = c.inVault ? '<span class="badge ok">' + icon('check') + 'In Vault</span>'
          : !c.onSystemDrive ? '<span class="badge muted">Not on ' + esc(sys) + ', safe</span>'
          : '<span class="badge warn">' + icon('alert') + 'Not backed up</span>';
        const can = !c.inVault && c.onSystemDrive;
        return `<div class="cand"><input type="checkbox" class="check" data-pick="${esc(c.id)}" ${R.picked.has(c.id) ? 'checked' : ''} ${can ? '' : 'disabled'} aria-label="Add ${esc(c.label)}">
          ${ui.tile(c.path, '', c.kind === 'folder' ? 'folder' : null)}
          <div style="min-width:0"><div class="t">${esc(c.label)}</div><div class="d">${esc(c.why)}</div><div class="p" title="${esc(c.path)}">${esc(c.path)}</div></div>
          <div>${status}</div></div>`;
      }).join('')}
    </section>`;
}

document.addEventListener('change', e => {
  const el = host();
  const id = e.target.dataset?.pick;
  if (!el || !el.contains(e.target) || !id) return;
  if (e.target.checked) R.picked.add(id); else R.picked.delete(id);
  const b = el.querySelector('[data-act=add-picked]');
  if (b) { b.disabled = !R.picked.size; b.innerHTML = `${icon('plus')}Add ${R.picked.size || ''} to Vault`; }
});

document.addEventListener('click', async e => {
  const el = host();
  if (!el || !el.contains(e.target)) return;
  const a = e.target.closest('[data-act]');
  if (!a) return;
  if (a.dataset.act === 'backups') {
    S.backupScope = { type: 'all' };
    return go('backups');
  }
  if (a.dataset.act === 'add-picked') {
    a.disabled = true;
    try {
      const r = await post('/api/reinstall/add', { ids: [...R.picked] });
      ui.toast(`Added ${r.added.length} to Vault. Back up to include them`, { type: 'ok', action: () => go('backups'), actionLabel: 'Back up' });
      await refresh();
      return renderReinstall(R.page);
    } catch (err) { a.disabled = false; ui.toast(err.message, { type: 'error' }); }
  }
  if (a.dataset.act === 'restore-all') {
    const latest = R.data.latest;
    const ok = await ui.confirm({
      title: 'Restore everything?',
      html: `<p>Copies back every item from the backup made ${esc(ui.timeAgo(latest.at))} on <b>${esc(latest.dest)}</b> that isn't in place right now. Things that are already there are skipped. Nothing is overwritten.</p>`,
      confirmLabel: 'Restore everything',
    });
    if (!ok) return;
    try {
      await post('/api/backups/restore-all', { folder: latest.folder });
      ui.toast('Restoring… you can follow along on the Backups page', { type: 'busy', timeout: 5000, action: () => go('backups'), actionLabel: 'Watch' });
    } catch (err) { ui.toast(err.message, { type: err.message.startsWith('Everything') ? 'ok' : 'error' }); }
  }
});
