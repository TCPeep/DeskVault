# FAQ

### Does DeskVault copy my files?
No. The library stores paths. Backups copy to a drive you pick; your original files stay where they are.

### Does it work offline?
Yes. The only online calls are fetching a saved link's preview image, and talking to Ollama (also on your PC) if Local AI is on.

### Does it work on Mac or Linux?
Not yet. The native helper is Windows-specific (NTFS file IDs, Windows Hello). The Node code is cross-platform, so a port isn't impossible &mdash; the tracking logic would need a different "same file across moves" approach on APFS/ext4.

### Can two people use the same DeskVault?
No. It's a personal app that binds to `127.0.0.1` and holds one library file. Nothing stops two people on different PCs each running their own DeskVault.

### Is my library safe if DeskVault crashes while writing?
Yes. Writes are atomic (temp file + rename), and a dated copy of the last 14 days of library.json is kept in `data/history/`.

### Can I move DeskVault's `data/` folder?
Yes: `node server.js --data D:\DeskVault\data`. The folder holds `library.json`, the website-preview thumbs, the AI search index and the log.

### What happens if a backup drive runs out of space mid-copy?
The job stops cleanly, marks the partial folder as failed, and your library and originals are untouched. Running the backup again continues from where it stopped (mirror mode) or starts a new dated snapshot.

### Why isn't drag-and-drop supported from Explorer?
Browsers hide the real file paths on drag-and-drop (they only pass a sanitised `File` object). DeskVault needs the real path to track the file, so it uses the Windows file picker instead.

### Why "127.0.0.1" and not "localhost"?
Both work, but on some locked-down Windows setups `localhost` has been remapped and `127.0.0.1` is more reliable. Both are allowed as the browser origin.

### Can I share my library with a cloud service?
You can put the whole DeskVault folder on OneDrive / Dropbox / Google Drive and it will work. But if those services rename or move your tracked files, DeskVault will treat each change as a move and re-find them &mdash; which can create a lot of churn. Pointing your backup drive at a cloud-synced folder is usually a better fit.

### What's "Needs attention"?
A page listing items DeskVault can't find at their last location. It offers Search again, Locate it myself, Restore from backup, or Remove from Vault. See [features/tracking.md](features/tracking.md).

### I locked something. Can I still see it in Explorer?
Yes &mdash; Lock is a DeskVault-side privacy screen, not file encryption. See [features/lock.md](features/lock.md).

### Does it send any telemetry?
No. There is no telemetry, no "phone home", no update check. Check the network panel in your browser &mdash; it talks to `127.0.0.1` only.
