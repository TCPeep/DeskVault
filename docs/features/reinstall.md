# Reinstalling Windows with DeskVault

The **Reinstall** page shows a one-screen answer to "what would I lose if I reinstall tomorrow?".

![Reinstall page](../images/reinstall-dark.png)

## Before

1. Open the Reinstall page.
2. The **Easy to forget** list suggests folders and files that a reinstall wipes but people often forget to back up: game saves (Saved Games, `AppData\LocalLow`, My Games), OBS scenes and profiles, VS Code settings and snippets, Windows Terminal settings, your PowerShell profile, your `.gitconfig`, user-installed fonts. Only the ones that actually exist on your PC are shown.
3. Click **Add** on anything you'd miss. (You can also add any other folder from the normal Add dialog.)
4. **Back up to another drive** (D:, E:, or a USB).

Every backup also saves:
- Your installed-apps list (`_This PC\apps-winget.json` and a plain-English `apps-installed.txt`).
- A runnable copy of DeskVault with `node.exe` next to it (`<drive>\Vault Backups\Vault app\`).
- A plain `READ ME FIRST.txt` at the backup root.

## After reinstalling Windows

1. Plug the backup drive in.
2. Open `<drive>\Vault Backups\Vault app\Start Vault.cmd`. DeskVault starts straight from the backup drive &mdash; no need to install Node.js first.
3. Go to **Reinstall &rarr; Restore everything**. Files go back to their original locations. If your Windows username changed, they land under the new user folder.
4. Open the printed `_This PC\HOW TO REINSTALL APPS.txt`. One `winget import` command brings most of your apps back.

## What is "known folders" aware

Windows "known folders" (Desktop, Documents, Pictures&hellip;) can be redirected into OneDrive. The Reinstall page reads where they *actually* are from `HKCU\Software\Microsoft\Windows NT\CurrentVersion\Explorer\User Shell Folders`, so it suggests the real paths rather than the default ones.
