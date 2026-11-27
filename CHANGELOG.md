# Changelog

All notable changes to DeskVault are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Bills**: a bill tracker with a page of its own in the sidebar. It shows:
  - a monthly total, with weekly, every-2-weeks, quarterly, every-6-months and yearly bills evened out so they add up correctly;
  - how much is left to pay this month, what's due in the next 7 days, and what's overdue;
  - a "Coming up" list and a month calendar.
- Marking a bill paid moves it to its next due date. A bill due on the 31st stays on the last day of shorter months. You can undo a payment, skip one, or record the real amount for bills that change each time.
- Auto-pay bills ask you to confirm the payment went through instead of being shown as late.
- Charts of spending by category and of what you paid in each of the last 6 months, plus a payment history and a CSV export (protected against spreadsheet formula injection).
- Privacy: you can lock bills behind Windows Hello (they're hidden from the browser and the activity log until you unlock) and blur amounts when sharing your screen. DeskVault only stores the last 4 digits of an account or card, and payment links are limited to http(s) with no logins in them.
- Optional Windows notifications before bills are due, and a count of bills that need you on the sidebar.
- Bills are included in backups and in library import.
- **Ask AI: saved chats.** Every conversation is kept (in `data\ai-chats.json`) and listed beside the chat, grouped by Pinned / Today / Yesterday / This week. You can search, reopen, rename, pin or delete chats, and follow-ups keep the whole conversation in mind. New chats get a short title from the model.
- **Ask AI: memory.** Facts the AI keeps in mind for every answer (in `data\ai-memory.json`). Start a message with "remember that…" or "forget…", click **Remember…** under an answer to pick facts from it, or add and edit them on the **Memory** panel. Memory is included in backups and library import.
- **Ask AI: project knowledge.** Folders are walked deeper (4 levels, up to 80 notes each) with READMEs, hand-off notes and `docs/` read first and in more detail. Every project folder (git repo, `package.json`, `.sln`/`.csproj`, Python or Rust/Go project) gets a "project overview" source with its location, stack, git remote, npm scripts, README intro and layout. Git remote URLs are stored without any login in them.
- **Ask AI: better answers.** Follow-ups are rewritten into a standalone search ("how do I deploy it?" becomes "deploy my-website"), shown above the answer. Answers use 8 sources instead of 6, sources show which project and collection they came from, and the model knows today's date.
- **Storage > Installed apps.** A second view on the Storage page lists every desktop program and Microsoft Store app with its icon, publisher, version, size, install date and when you last opened it (from Windows' own launch history, including Start-menu shortcuts). Filter by "not opened in 6 months", "no launch history", unrated or leftover entries (listed as installed but their files are gone); sort by size, name, last opened, install date or rating.
- Rate apps 1-5 stars and keep a note on each, for your own clean-up decisions. Ratings stay on this PC.
- Uninstall one app or tick several and uninstall them together. They run one at a time with each app's **own uninstaller** (Windows may ask for permission), and DeskVault waits until each is really gone, also catching uninstallers that hand off to a temporary copy, before starting the next. Skip the current one or cancel the rest at any time. Uninstall commands are only ever read from the Windows registry on the server, never sent from the browser.
- An app's details show its location (with Open), website and help links, the exact uninstall command, and a **Measure** button for apps that don't report their size.

### Changed
- The native helper (`bin\VaultWin.exe`) and the launcher (`bin\Vault.exe`) are now rebuilt separately, so updating the helper no longer fails while DeskVault is running from the launcher.
- Saved chats show "Locked item" for any source that has since been locked. The answer text itself is kept, so delete a chat if it quotes something you have since locked.

## [1.0.0] &mdash; 2026-10-24

First public release.

- Library with items (files, folders, links, notes), collections and tags.
- Move detection on the same NTFS drive via file IDs, across drive letters via volume serial, and across drives via content fingerprint.
- Backups: snapshots and mirror, by hand or on a schedule, with a runnable copy of DeskVault included on the backup drive.
- Reinstall page with "Easy to forget" suggestions and one-click restore everything.
- Storage: scan drives/folders, find stale and duplicate files, delete to Recycle Bin or move to another drive.
- Windows Hello lock (privacy screen) for items and collections.
- Built-in viewer: highlighted code, rendered Markdown, PDFs, images, audio/video, HTML (scripts off), folder tree.
- Local AI through Ollama: ask about your own notes/files with cited sources, summarize/explain in the viewer, tag suggestions.
- "Save to Vault" bookmarklet.

[1.0.0]: https://github.com/TCPeep/DeskVault/releases/tag/v1.0.0
