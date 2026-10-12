# macOS packaging and release gates

The shared Electron application and Go helper target Apple Silicon (`arm64`) and Intel (`x64`). GitHub Actions defines one native Mac runner per architecture. No Mac is required on the developer's desk to author or dispatch this pipeline, but a workflow file is not evidence that it has run. The current Windows session cannot execute Apple package tools, Installer, Gatekeeper, Finder or real Mac window tests.

## What is shipped

Each architecture has a real `.pkg` installer containing `Claude Country Club.app`, the native `Contents/Resources/ccc-hook` helper and `Contents/Resources/Uninstall-Claude-Country-Club.command`. Offline practice needs no provider, runtime installation, account or API. The package installs into `/Applications` or the Installer's current-user Applications domain. Non-system external volumes are disabled. Bundle identifiers must match; newer on-disk versions are checked; upgrades atomically replace app-owned bundle contents. Saves remain outside the app.

The installer asks the running Country Club app to close through native must-close metadata and has a preflight refusal if it is still running. It never kills clients or runs provider configuration setup. Its sole package script is `preinstall`; it inspects process names and exits. The OS may authorize system Applications installation, but no root script reads or changes user provider settings. The user connects clients from the app after reviewing the patch and any native client trust prompts.

Unsigned artifacts include `Setup-PREVIEW` in their filename and are uploaded under `UNSIGNED-PREVIEW` CI artifact names. They are engineering test packages, not production downloads. Do not advise users to bypass Gatekeeper or disable OS protection. A passing unsigned build only establishes the tests that actually ran.

## Build and verification

Run on the native target Mac with Node and Go installed:

```bash
npm ci
npm run verify
chmod +x installers/macos/Uninstall-Claude-Country-Club.command installers/macos/pkg-scripts/preinstall
node scripts/verify-mac.mjs --source
# Apple Silicon uses arm64; Intel uses amd64 for Go and x64 for builder.
CCC_BUILD_ARCH=arm64 npm run build
npx electron-builder --mac pkg --arm64 --publish never
node scripts/verify-mac.mjs --pkg release/Claude-Country-Club-Setup-PREVIEW-0.1.0-arm64.pkg --arch arm64 --smoke
```

The verifier expands the PKG with `pkgutil --expand-full`, verifies component identity and install location, checks actual Mach-O app/helper architectures, confirms bundled executable removal tooling, rejects unexpected package scripts, and exercises native structural cleanup against an isolated temporary home. It verifies unrelated hooks and progress survive and modified owned references block cleanup. The packaged app smoke test reuses the existing Electron E2E against isolated provider homes; it covers gameplay persistence, private IPC, lifecycle visibility, no-focus automatic showing, and sandboxed rendering. These fixtures do not contact providers or use subscriptions.

`work/mac-verification/result-<arch>.json` records the installer SHA-256 and exactly which artifact gates passed. CI uploads that report and packaged-app E2E output alongside the preview PKG. A failure does not become a successful release merely because an artifact was uploaded.

For a deliberately installed package on a disposable Mac profile, additionally run:

```bash
node scripts/verify-mac.mjs --pkg /path/to/test.pkg --arch arm64 --installed --app '/Applications/Claude Country Club.app'
```

This reads the installed package receipt and verifies the installed helper exists. It does not install the package or alter a real user's provider configuration. Test normal Installer fresh install, repair, upgrade, cancellation, insufficient space, permissions and downgrade refusal separately on a disposable system. Confirm the packaged `LSMinimumSystemVersion`, distribution OS constraints, target architecture and selected Electron version agree before advertising a minimum macOS version.

## Signing and notarization

The pinned builder schema and local implementation were inspected: `mac.binaries` explicitly includes `Contents/Resources/ccc-hook` and resolves it inside the app bundle for signing. Hardened runtime and strict verification are enabled. The entire bundle includes the removal script as a sealed resource. Scripts do not need a separate Developer ID executable signature; their integrity is covered by the enclosing signed bundle. Verify that assumption against the actual final signature, not source intent.

Public distribution requires Developer ID Application signing for the app, Electron helpers and Go helper; Developer ID Installer signing for the PKG; notarization; and stapling. Configure Apple signing identities and notarization credentials only in protected, explicitly authorized release CI. The current preview workflow intentionally has no signing secrets and never publishes. A public release build must override the PREVIEW artifact name only after its signing path is configured; require forceCodeSigning in that release invocation so absent credentials fail the build.

After builder signs/notarizes the app and creates the signed PKG, submit the PKG itself with `xcrun notarytool submit ... --wait` using a protected keychain profile or App Store Connect key; staple the PKG and app where appropriate. Do not print credentials in logs. Preserve notarization logs and artifact checksums. Run the final verifier with `--require-signed`; it checks strict nested code signatures, helper signature, PKG signature, Gatekeeper assessment and stapled tickets. It intentionally fails if an ad-hoc or unnotarized artifact cannot pass those gates. Both architectures require this verification; do not assume one signature result proves both.

## Removal and repair

Quit the app. In Finder, Show Package Contents and open `Contents/Resources/Uninstall-Claude-Country-Club.command`. The assistant asks before making changes, refuses root execution, verifies its enclosing app identity, and runs the native ledger cleanup as the logged-in user. Only unchanged owned groups are removed. Modified helper references, unsafe paths, malformed ownership, or inaccessible files stop removal while retaining the app and ledger. Restore or manually remove those owned references, then retry. It never resets saves, removes provider authentication, or changes other users' settings.

After successful cleanup, Finder moves the app to Trash using normal OS authorization. If Finder declines or lacks permission, the assistant reports that integrations are disconnected and the user can finish removal in Finder. It never elevates the helper. `--cleanup-only` disconnects integrations while retaining the app; `--check` verifies bundled tool identity without changing files. The package receipt remains installation history; dragging an app to Trash does not undo hooks or receipts automatically. Progress and private backups are retained by default. Explicit progress deletion is a separate user action.

Reinstall the same or a newer signed PKG to repair binaries. Reconnect only if the user asks; do not silently re-enable removed hooks. User directories and their integration ledgers must survive bundle replacement. Moved app bundles are not a supported automatic relocation target; reconnect integrations if the native helper path changes.

## Remaining acceptance gates

No hosted Mac run, public signing identity, notarization result, real client trace or real Mac desktop result is established by the Windows source checks. Before calling Mac beta or stable ready, inspect successful arm64 and Intel CI runs and perform normal Installer installation, first run, native trust review, live Claude/Codex start/attention/stop/interrupt, permission prompts, concurrent sessions, save recovery, Finder removal, and reinstall on real logged-in desktop sessions. Test keyboard focus, Spaces, multiple displays, display scaling, sleep/wake, disconnected displays, and sound/startup defaults. Test standard-user and administrator installs without running the integration helper as root. Record OS/client/build versions and exact evidence.

## Windows cross-compilation check (October 12, 2026)

Run `npm run verify:mac-helper-crossbuild` on Windows to compile the native helper for darwin/arm64 and darwin/amd64 into work/mac-helper-crossbuild/. The check inspects each Mach-O header for the expected CPU and executable file type, verifies embedded GOOS/GOARCH/CGO metadata, and records hashes. Both targets passed locally with Go1.27.0. This does not execute either binary, build an Electron Mac bundle/PKG, or validate Installer, permissions, signing, notarization, socket delivery or focus. Native hosted jobs remain unrun. The Windows CI source now includes this check and retains its result; the changed CI has not run remotely.
