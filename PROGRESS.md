# Claude Country Club progress

Updated October 12, 2026. Goal active. Working unsigned Windows preview; production acceptance is incomplete.

## Current deliverable

- Parent outputs/Claude-Country-Club-Setup-0.1.0-x64.exe; SHA256 **d448ef2fa85546dd6f2c626e6dc6d4e37107cc1a2c66dc3b3dc07625b4b0aa37**; Authenticode **NotSigned**. Repository release/ has the same candidate. Docs and acceptance evidence are in parent outputs/.
- No live provider configuration/enrollment, subscription credential handling, inference requests, paid services or release publication. Scoped test installations and registration were removed. No test process remains live.

## Implemented

- Minimal course-first Electron UI using GPT-6.1 Sol High; pull/release shooting, accessible keyboard/zoom, nine curated holes and deterministic offline variety.
- Durable SQLite shot journal/checkpoints, restart/import/export, retry, corrupt-save preservation and explicit recovery.
- Sandboxed local renderer, automatic/sound/startup off by default; inactive automatic show, conservative concurrent-session lifecycle, freeze/save/hide, lock/sleep/display handling and renderer parking. Lazy protocol avoids an unused startup renderer.
- Private native IPC and credential-free hook adapters, exact preview/stale guards/private backups/owned removal; supported payload delivery remains fixture-tested and certifiedClients is empty.
- Bounded private diagnostics/history and conservative foreign/linked/malformed-file preservation. Guided transactional current-user Windows install, repair, safe upgrade/downgrade policies and scoped uninstall.
- macOS Apple Silicon/Intel PKG configuration, hosted CI, source verifier, explicit LF rules for native package scripts and signing/notarization runbook; native jobs have not run.

## Latest evidence

- Typecheck, **144 unit tests in 14 files**, Go helper/transaction checks pass. Full installed suite passes: native metadata/discovery, console-free helper, lazy startup, E2E, pointer/keyboard ownership, four focus interruptions, four startup-ordering cases, lifecycle/display/UI/save/progress/diagnostic/history/private identity/review, downgrade refusal, repair/repaired E2E and uninstall.
- Final current-hash installer interruption, real Windows deny-delete file lock and Unicode-path recovery pass; registration removed. Mac source verifier passes. Both Mac helper architectures now cross-compile on Windows with checked Mach-O/build metadata; native execution/PKG remain unverified. Windows CI source includes the check and trace retention; remote jobs remain unrun.
- Active pulls now cancel on course/window blur or hidden-document events, restore initial aim and ignore later release. Packaged/installed regressions preserve exact progress and recover with one fresh shot. Tests disable focus emulation and use an owned blank focus destination with state-based waits; hidden visibility is a synthetic handler fixture. Physical Alt-Tab/outside-window routing remains open.
- Space/Enter/arrows cannot compete with an active pull; Escape repeat cannot hide after cancellation. Existing three pointer-interruption/eight gesture cases pass. Historical missed-shot and unexpected second-shot observations remain unexplained; these deliberate conflicts/interruptions do not establish their cause.
- One earlier installed discovery test timed out after fixture --version invocation. Evidence retained at work/installer-test/client-discovery-timeout.json. Later isolated/full runs pass; phase records were added. Timeout cause remains unexplained. Twelve bounded trials/48 fresh launches subsequently pass with durable phase timelines (maximum inspect277ms/close251ms); passing repetitions do not explain the original stall.
- Windows Codex discovery supports three bounded npm native layouts and extended-length paths; explicit-only --version uses private homes/no inherited keys/version-only output and preserves fixture config. Actual isolated npm probe reports0.159.3; other native installs previously reported different versions. No probe certifies trust, account status or real event delivery.
- Current independent installed lifecycle sample: inactive first show33.70ms beyond1s; post-game Electron/helper252.94MiB. Current full owned-process benchmark: cold192.46–193.98MiB/parked259.72–260.06MiB, exact restore/security/pixels pass; old result preserved. Private cache-release control stays261.63MiB with HTTP cache0 and main heap6.75MiB, so no production change adopted. Different scopes are separate;200MiB target remains unmet. No memory trimming or isolation/graphics weakening.
- Observed native fresh/repair wizard Cancel before extraction remains historical on ea205e99; not rerun on the current payload. During-extraction/clean-profile cancellation remains open.

## Remaining gates

- Explain retained input observations and the discovery-test timeout; sustained compositor/hardware/accessibility testing.
- Certify real signed-in Claude Code/Codex trust/start/permission/stop/interruption behavior. Desktop/IDE/cloud/remote surfaces remain unverified. Live enrollment requires authorization.
- Meet post-game200MiB resource budget; validate physical input, screen reader, lock/display delivery and OS-level offline behavior.
- Run native macOS CI and real-Mac PKG/focus/Spaces/sleep checks; obtain authorized signing/notarization credentials and owner license decision.
- Clean-profile/during-extraction cancellation, physical disk/power loss, enterprise restrictions and full requirement-by-requirement release audit.

Details/evidence: docs/ARCHITECTURE.md, ACCEPTANCE.md, COMPATIBILITY.md, PERFORMANCE.md, MAC-RELEASE.md and PROGRESS-HISTORY.md. Passing fixtures and unsigned artifacts are not production readiness.
