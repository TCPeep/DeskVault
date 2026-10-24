# Troubleshooting

### "Can't reach the DeskVault server"
Open PowerShell in the DeskVault folder and run `node server.js`. If it exits immediately, read the error. The two common ones are:

- **Port already in use** &mdash; another program (sometimes an old DeskVault) is on 4477. Start it on a different port: `node server.js --port 4478`.
- **Node not found** &mdash; install Node.js 20+ from <https://nodejs.org> and try again.

### "First run failed to build the Windows helper"
`csc.exe not found at ...`: the .NET Framework 4 C# compiler is on every Windows 10/11, so this is unusual. Make sure `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` exists. If something has removed it, install the [.NET Framework 4.8 developer pack](https://dotnet.microsoft.com/download/dotnet-framework/net48).

### A tracked file keeps showing as "Needs attention"
It's probably on a USB drive that isn't plugged in, or in a folder that has permission problems. Click **Locate it myself&hellip;** to point DeskVault at the current location.

### Backup is slow the first time
Snapshots copy everything the first time, then they're done. A mirror only re-copies changed files, so the second mirror of the same library is fast.

### Backup to USB fails partway through
Reconnect the drive and try again. DeskVault doesn't delete anything on a failed backup; the partial folder is kept for inspection.

### Ask AI shows "Ollama isn't running"
Install [Ollama](https://ollama.com), then click **Start Ollama** on the Ask AI page.

### Ask AI runs out of memory
Pick a smaller chat model (e.g. `llama3.2:3b`). Lower `OLLAMA_CONTEXT_LENGTH` in your Windows environment variables (DeskVault sets it to 16384 by default).

### Windows Hello says "NotConfiguredForUser"
Open Windows Settings &rarr; Accounts &rarr; Sign-in options and set up a PIN. Hello needs at least a PIN to work.

### Storage scan is slow
First scan of a whole drive can take minutes. Later scans are faster because file metadata is cached. Scanning just the folders you care about is quickest.

### Where are the logs?
`data/vault.log`. It rolls over to `vault.log.old` at 2 MB.

### How do I reset DeskVault?
Stop it, delete the `data/` folder, start it again. Your library is in `data/library.json`; your files on disk are not touched.
