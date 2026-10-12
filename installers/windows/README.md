# Windows installer and recovery

The assisted, current-user NSIS installer requires x64 Windows 10 or later. It never enrolls provider hooks, enables login startup, starts the game after completion, or requests administrator elevation. `/allusers` is rejected. Same-version `/REPAIR` replaces app files; older versions are refused before normal install work.

## Replacement transaction

`native/ccc-hook/cmd/ccc-installer` is a separate installer coordinator, not the coding-agent hook process. The installer embeds it in its private temporary directory so it can rename app directories without locking itself. The app also includes a copy for diagnostics/recovery. It has four explicit operations: `prepare`, `commit`, `finalize`, and `recover`, each taking an absolute installation directory. No operation reads or changes provider settings or saved rounds.

1. Refuse a running app during silent setup. Interactive setup can ask the normal app to save and quit; it never force-kills a round.
2. Recover a prior interrupted transaction, then compare installed and requested versions. Recovery is refused while a Country Club process runs.
3. Verify the selected target agrees with the fixed current-user Country Club registration and is empty or contains the expected app skeleton. Refuse linked ancestors and unowned transaction directories.
4. Create `<install-directory>.ccc-transaction` with an ownership journal and a `new` directory on the same volume. Snapshot only the two fixed Country Club HKCU registration keys.
5. Extract the embedded application into `new`. Verify every packaged file against the generated SHA-256 manifest, with only the generated uninstaller and icon allowed as extras. Missing, corrupt, extra or linked assets block promotion.
6. Mark the journal as switching, rename the previous app into `previous`, and promote `new`. Failed promotion restores the old directory. Never invoke the old uninstaller during replacement.
7. Write registration and shortcuts, then finalize. Keep the old app until this point. Mark the transaction committed before removing backups; retain the journal if backup cleanup fails.

An interrupted switch rolls back app files and the captured product registration on the next installer attempt. A committed transaction resumes cleanup and keeps the new app. A modified replacement or unexpected recovery file is preserved for manual review. Do not delete recovery directories as a generic troubleshooting step: they may contain the previous working app.

## Pinned template integration

The custom NSIS header changes the compiler's include working directory so the standard electron-builder main script selects this directory's `installSection.nsh`. The default main script and signed-uninstaller generation remain in use. `scripts/package-manifest.cjs` pins the normalized main-template hash and refuses a changed template; review include behavior and rerun all installer acceptance before changing electron-builder. Warning 6010 is disabled only because the standard template's old-uninstaller functions are deliberately unused. Other compiler warnings remain errors.

The manifest runs after executable signing. The coordinator is explicitly passed through the configured Windows signer before it is copied for NSIS embedding. Current artifacts remain **NotSigned** because no signing identity is configured. SHA-256 manifest checks detect extraction corruption; an unsigned manifest is not an authenticity guarantee.

## Local verification

- `npm run package:win`: build the current installer.
- `npm run test:installer`: install only under `work/installer-test/app`, run installed E2E, refuse all-users/downgrade requests, repair, rerun E2E, uninstall.
- Build a local next-version fixture: `npx electron-builder --win nsis --x64 --publish never --config.extraMetadata.version=0.1.1 --config.directories.output=work/upgrade-release`.
- `npm run test:upgrade`: exercise 0.1.0 to 0.1.1, corrupt staging, unfinalized-switch recovery through the actual installer, exact saved-shot preservation, isolated hook/auth preservation, running-app refusal, actual downgrade refusal and uninstall. It refuses product registrations outside its own workspace target and refuses an existing live hook ledger.
- `npm run test:native`: helper tests plus transaction and scoped-registry fault tests. Transaction tests inject rename failure and interruption states; they are not physical power-loss tests.

These checks do not substitute for a clean Windows account with no developer runtimes, during-extraction cancellation, disk exhaustion, enterprise policy restrictions, unusual filesystem layouts, or signed-download SmartScreen acceptance. Keep those release gates open until tested. Installation and repair do not enroll provider hooks. Connections are managed explicitly in the app; uninstall also removes Country Club’s owned hook entries and stops if cleanup cannot proceed safely.

Observed pre-extraction fresh and existing-install Cancel acceptance is documented in docs/ACCEPTANCE.md. The manual harness uses unique workspace targets and remains outside unattended CI; it does not certify a clean Windows profile or cancellation during extraction.

