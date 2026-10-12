# Mac package installation

The primary Mac artifacts are PKG installers, built separately for Apple Silicon and Intel. The package installs the app under /Applications; no provider settings, startup items, or machine services are installed by package scripts.

Connect or remove integrations from the logged-in app's Connections screen. Before deleting the app, use Remove integrations. For recovery, run the app-bundled native helper with `--cleanup --data-dir "$HOME/Library/Application Support/Claude Country Club"` as the logged-in user, never as root. Cleanup preserves modified and third-party hooks and never deletes progress.

The app includes `Contents/Resources/Uninstall-Claude-Country-Club.command`, a user-scoped removal assistant. It refuses root, prompts for confirmation, runs safe structural cleanup, and then asks Finder to move the app to Trash. Modified owned references block removal and preserve the helper. Saves remain by default. PKG installation has no automatic inverse when an app is dragged to Trash.

See [the Mac release runbook](../../docs/MAC-RELEASE.md) for native Apple Silicon/Intel CI, preview artifact limits, payload and receipt checks, code signing, notarization and real desktop acceptance gates.
