# Getting started

## Install

1. Install [Node.js 20 or newer](https://nodejs.org) &mdash; the LTS installer is fine.
2. [Download the latest DeskVault release](https://github.com/TCPeep/DeskVault/releases/latest), or clone the repo:
   ```powershell
   git clone https://github.com/TCPeep/DeskVault.git
   cd DeskVault
   npm install
   ```
3. Double-click **`Start Vault.cmd`**, or run `npm start`. DeskVault opens at <http://127.0.0.1:4477>.

The first run compiles a tiny Windows helper from `native/*.cs` using the C# compiler built into every Windows 10/11, and downloads the viewer libraries (highlight.js, marked, DOMPurify) from npm.

## First steps

1. **Add &rarr; Folders&hellip;** your `Projects` folder, your `Documents\Taxes`, your `Pictures\Holiday`.
2. In **Settings &rarr; Backups**, set a backup folder on another drive (USB stick is fine).
3. Click **Back up now**. A snapshot lands in `<drive>\Vault Backups\<date time>\`.
4. In **Settings &rarr; Windows**, turn on *Start with Windows*.

## Save websites

Drag the **Save to Vault** bookmarklet from Settings onto your browser's bookmarks bar. On any site, click it &mdash; the site is saved with its title, description and preview image.

## Local AI (optional)

- Install [Ollama](https://ollama.com).
- Open the **Ask AI** page.
- Click **Download search helper** (it fetches `nomic-embed-text`), then pick a chat model.
- Ask things like "when does my car insurance renew?" or "which project uses Vite?". Answers cite numbered sources you can click.

See [features/ai.md](features/ai.md) for how indexing works and how to free GPU memory before gaming.
