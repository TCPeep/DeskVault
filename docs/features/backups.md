# Backups

DeskVault backs up tracked files and folders to any drive you choose. It never copies files out of DeskVault's library file: every backup includes a manifest (`vault-backup.json`) with the original locations and your library, so a single item or the whole lot can be restored on a fresh install.

![Backups page](../images/backups-dark.png)

## Two modes

- **Snapshot** &mdash; full copy, dated, kept forever (until you delete it).
  Folder: `<drive>\Vault Backups\<yyyy-MM-dd HH.mm.ss>\`.
- **Mirror** &mdash; one copy per PC, only changed files re-copied. Folder:
  `<drive>\Vault Backups\Mirror - <PC name>\`. Fast once the first copy is done.

## Automatic backups

In Settings, turn on **Automatic backups**, pick how often (daily/weekly) and
pick the drive. If the drive isn't plugged in when the backup is due,
DeskVault waits and tries again later. Automatic snapshots are pruned to
keep only the N newest (default 5).

## What's in every backup

```
<drive>\Vault Backups\2026-10-24 15.30.12\
    _This PC\
        apps-winget.json         install your apps back with 'winget import'
        apps-installed.txt       plain list of what was installed
        HOW TO REINSTALL APPS.txt
    vault-backup.json             manifest: originals, mode, your library
    <item 1>\                     copies of the files, folder structure kept
    ...
<drive>\Vault Backups\Vault app\  a runnable copy of DeskVault, with node.exe
<drive>\Vault Backups\READ ME FIRST.txt
```

## Restore

- **One item**: Backups page &rarr; pick a snapshot &rarr; *Contents* &rarr; *Restore*.
- **Everything** (after reinstalling Windows): Backups page &rarr; *Restore everything&hellip;* on that snapshot. If your Windows username changed, files land under the new user folder.
- **Just the library on a fresh install**: *Restore&hellip; &rarr; Import library*.

> [!NOTE]
> **Restores never overwrite.** If something already exists at the original location, the restored copy lands beside it with a numbered suffix. You decide which to keep.

## Backup excludes

Default: `node_modules, __pycache__, .venv, venv, .next, .cache, .parcel-cache, Thumbs.db, desktop.ini`. Change the list in Settings. These are rebuildable or junk and would otherwise bloat every snapshot by gigabytes.

## File timestamps

Backing up a file sets its "last opened" (atime) back to what it was, so antivirus-style background scanning doesn't make everything look recently used in the Storage view.
