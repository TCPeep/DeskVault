# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's **private vulnerability reporting** on this repo: Security tab &rarr; **Report a vulnerability**. Or email the maintainer at the address listed on <https://github.com/TCPeep>.

Please include:
- What you did (one or two sentences).
- What happened that shouldn't have.
- The affected version (bottom of the Settings &rarr; About panel).

The maintainer will acknowledge within a week, agree on a fix date with you, and credit you in the release notes unless you'd rather stay anonymous.

## Supported versions

Only the latest release is supported.

## Scope

In scope:
- Any way to make DeskVault send or expose data to anything outside this PC without the user's action.
- Any way for a locked item's name, path or contents to reach the browser or the AI model.
- Any way for a web page in a browser tab to drive DeskVault's API (CSRF).
- Any way to make DeskVault delete, move or overwrite a file the user didn't ask it to.
- Any way to get arbitrary code execution via a crafted library.json, backup manifest or saved link.

Out of scope:
- Anyone with physical access to the PC or admin on the account (DeskVault isn't a sandbox).
- Issues that need the user to install a malicious npm package themselves.
- Dependency CVEs that aren't reachable in this app.
