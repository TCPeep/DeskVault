# Contributing to DeskVault

Thanks for your interest. Small, focused PRs are easiest to merge.

## Before you start

- If the change is bigger than a quick fix, open an [issue](https://github.com/TCPeep/DeskVault/issues) first so we can agree on the shape.
- Grep the code for the thing you want to change. The codebase is small (~8k lines) and prefers the surrounding style over a specific linter.

## Setup

```powershell
git clone https://github.com/TCPeep/DeskVault.git
cd DeskVault
npm install
npm start
```

Open <http://127.0.0.1:4477>. For a sandbox library, point `--data` at a scratch folder:

```powershell
node server.js --port 4479 --data D:\scratch\deskvault-dev
```

## Code style

- Follow the surrounding code: comment density, naming, idioms. Match it; don't improve it.
- Vanilla JS, no frameworks. No build step.
- Keep features **off the network by default**. Any new outbound call needs a strong reason and a switch in Settings.
- Never ship analytics, telemetry or update checks.
- Prefer small, obvious functions over clever ones.

## Tests

```powershell
npm test        # end-to-end smoke test on throwaway fixture files
```

A PR that adds a new API route should extend `test/smoke.mjs` to cover it.

## Pull requests

- One topic per PR.
- Keep the diff small; split refactors from behaviour changes.
- Include screenshots for UI changes (any size is fine).
- Update docs under `docs/` where behaviour changes.
- The last line of commit messages:
  ```
  Co-Authored-By: <your name> <you@example.com>
  ```
  if you worked with someone, so we can thank them.

## Security

Never open an issue for a security problem &mdash; see [SECURITY.md](SECURITY.md).

## License

By submitting a PR you agree your contribution is licensed under the project's GPL-3.0 license with the additional terms in [NOTICE](NOTICE).
