# Claude Country Club

A local desktop mini golf companion for waiting on Claude Code or Codex. Play a few shots while your coding agent works, then resume coding when it needs you. Your golf progress carries into the next wait.

## Project status

The cloned repository was empty. It now contains an Electron application, nine locally varied courses, durable SQLite saves, Claude Code/Codex hook adapters, a private native helper, and installer build configuration. Windows development and packaged-app end-to-end checks have passed. Release acceptance is still in progress; current installers are unsigned previews.

## Run locally

Install Node.js 22 and Go, then run `npm ci`, `npm run verify`, and `npm run dev`. Build a Windows Setup EXE with `npm run package:win`. End users receive the installer and need neither Node nor Go.

Automatic mode and provider connections are opt-in. Review the configuration preview in Connections before enabling hooks. Installing hooks does not establish client trust or prove compatibility with a particular client version. See [compatibility and limitations](docs/COMPATIBILITY.md). The app makes no model API calls and never handles subscription credentials.

Read [privacy and local data](docs/PRIVACY.md) before connecting: previews show only Country Club hooks, while complete local rollback backups may contain user-added sensitive settings. Session pseudonyms use a private installation key; they are not an anonymity guarantee.

macOS Intel and Apple Silicon builds are configured in GitHub Actions. Hosted jobs, signing/notarization, and real-Mac acceptance remain release gates.

Read [Product architecture](docs/ARCHITECTURE.md) for the Electron application, Claude/Codex subscription-compatible integrations, quiet desktop behavior, persistent gameplay, Windows installer, macOS build and signing workflow, and delivery milestones.

## Product requirements

- Use existing signed-in coding clients without handling provider credentials or making paid API calls.
- Stay local, avoid stealing focus, and never interfere with coding-agent permissions.
- Distribute native installers: Windows Setup EXE and macOS PKG.
- Preserve existing agent configuration and provide repair and integration removal.
- Build macOS artifacts on hosted Mac runners and validate on real Mac desktops before stable release.

See the architecture completion gates before describing any planned feature as supported.

Windows app replacement now stages and validates files before a recoverable directory switch. Local real-version upgrade and installed-app acceptance pass; see [installer recovery details](installers/windows/README.md) and [remaining acceptance gates](docs/ACCEPTANCE.md). Clean-account interactive tests, signing, certified live clients and native Mac execution remain outstanding.
