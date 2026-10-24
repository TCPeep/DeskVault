# Lock (Windows Hello)

A **privacy screen** inside DeskVault. Lock single items from their &hellip; menu, or whole collections in their edit dialog. Locked things disappear from DeskVault's sidebar, pages and search until you unlock with Windows Hello (your PIN, fingerprint or face).

## What locking does

- Locked names, paths and file contents are **never sent to the browser** until you unlock.
- Locked items can't be opened, removed or deleted through DeskVault.
- Locked items are **never indexed** or sent to the AI.
- The live-updates channel (SSE) redacts moved-item events so a locked file's new path can't leak through notifications.

## What locking is **not**

> [!WARNING]
> Lock is a **privacy screen**, not file encryption. The files on disk are not encrypted and are still accessible to any program that can read your user profile.

For real encryption, keep sensitive files inside a BitLocker-encrypted folder or an encrypted container (e.g. VeraCrypt), and add that container to DeskVault.

## Auto-lock

After **N minutes without using anything locked** (default: 5), DeskVault locks itself again. Change it in Settings. "Using something locked" means opening a locked item, visiting a locked collection, or clicking Unlock.

## If Windows Hello breaks

If Hello stops working on your PC (new user, fingerprint reader removed, etc.), locks can be removed by hand: stop DeskVault, open `data\library.json`, set `"locked": false` on the affected items and collections, then start DeskVault again.
