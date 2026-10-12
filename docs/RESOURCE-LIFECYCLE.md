# Resource lifecycle investigation

October 12, 2026. This experiment supports an implementation direction; it is not a shipped architecture or a completed resource gate.

## Paired evidence

Both runs use packaged executable 50522088, default graphics and the same read-only collector on the Windows reference machine. Totals include every recursively discovered descendant and native helper; shared pages can count more than once. No working-set trimming, private-byte substitution, isolation weakening or GPU termination is used.

| Local sample | Current app | Separate background/game experiment |
| --- | ---: | ---: |
| Cold background |190.82–190.96 MiB |190.93–191.09 MiB |
| Hidden after gameplay |259.14 MiB after normal renderer parking |191.21–191.25 MiB after game process exit |
| Active after real settled shot |354.83 MiB |559.31 MiB across both full apps |
| Observed reopen including instrumentation |126.60 ms |315.60 ms |

The experiment retains a windowless app with its tray/native broker and accepts actual start/stop fixture events. A second independent app plays a real drag shot, freezes, exits normally and reopens its private store. An independent read-only SQLite query establishes the final committed checkpoint after quit. Exact revision/state restore, paused reopening, secure renderer preferences and turf/checkerboard pixels pass. After the reopened game exits, memory returns to the background range. All owned roots and measured descendants exit normally. There is no production relay or shared state; both apps have separate stores and helpers.

This demonstrates reclaiming retained memory by exiting the game host in this sample. It does not prove an integrated controller/worker bridge fits the budget. The shipped app still exceeds 200 MiB. Active memory and reopening cost are material tradeoffs; these are single-machine samples, not automatic-open or compositor certification.

Initial probe syntax, CIM-timeout and cleanup-status failures remain under work/split-process-resources. The corrected collector uses Microsoft's read-only [Tool Help snapshot](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/nf-tlhelp32-createtoolhelp32snapshot) and [parent/PID entries](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w), then the same .NET WorkingSet64 counters. A disappearing process invalidates the whole sample. Cleanup compares PID/start time and requires every measured descendant to disappear. A copied scope label in the reference report was corrected without changing measurements; the original is retained.

## Implementation direction

First prototype a real window worker boundary while retaining the controller's native broker, session reducer, tray, power/display handling and storage ownership. The packaged inherited-channel prerequisite now passes on Windows: an actual Electron main spawns another packaged Electron main with an inherited Node IPC channel. Unicode JSON (50bytes) and UI-sized JSON (131086bytes) round-trip with matching byte counts/hashes, send callbacks complete, both ends observe disconnect and all owned descendants exit normally. Parent/PID and separate private profile identities are checked. This does not require a new production localhost listener; inspectors only configure/observe the fixture.

Run `npm run probe:inherited-ipc` with CCC_EXECUTABLE set to reproduce. Evidence is work/inherited-ipc/result.json. Earlier fixture-expression and timeout failures are retained. A diagnostic listener identified ReferenceError: require is not defined in the deferred fixture callback; capturing the crypto module during listener setup fixes the probe. This explains the probe failure, not the historical application attention timeout. Fixture listeners are inspector-installed and the uncaught-exception observer affects failure handling. There is no production worker, handshake, bounded RPC validator or shared storage implementation; native Mac remains untested. Independent experiment profiles are not the production integration design.

The controller remains the sole owner of SQLite, settings, identity/connection files and configuration previews/backups. The worker owns the bundled secure protocol, BrowserWindow, preload and renderer, with no second tray, native broker or store. Preserve the current sandbox, isolation, CSP, permission/navigation denial and projected configuration privacy.

Messages need bounded payloads, protocol version, request identity and worker generation. Validate both endpoints; reject responses from stale workers. Keep save revision checks and acknowledgements, and never turn bridge failure into success. Native hook frames remain separate from larger UI IPC payloads. Connection tokens must not appear in command lines; an arbitrary worker flag must not attach to the controller.

The first source building block now exists in `windowWorkerProtocol.ts`: protocol version1, 256KiB JSON bound, 48-hex startup nonce, positive bounded generation, safe request IDs and separate controller/worker message parsers. Unit tests cover valid startup/response traffic plus oversized, malformed and stale/wrong-nonce rejection. This module has no runtime worker wiring yet, so it changes neither the app's current single-process behavior nor the installer.

The controller retains eligibility, selection, ambiguity, lock/sleep holds and dismissal. Stop/attention during worker startup cancels pending show; automatic show remains inactive. Freeze/hide keeps the accepted-event latency contract. Worker exit requires a settled acknowledgement or an explicit failure path preserving the last acknowledged round. Crash recovery cannot fabricate a stroke or revive a completed wait. Practice remains usable without optional integration.

Installer save-and-close must settle and terminate both processes through the real singleton owner before changing files. Rerun running-game refusal, repair/upgrade recovery, process cleanup, mid-flight crash recovery and the installed suite. Native Mac focus/Spaces/sleep/PKG checks remain external gates.

Measure the integrated implementation before adoption. If the persistent Electron controller lacks budget headroom or active cost is unsuitable, evaluate a native background host retaining the existing Go listener; that requires native tray/lifecycle work and separate platform validation. Keep the 200 MiB target and existing latency/security requirements intact.

## Reproduce

Set CCC_EXECUTABLE to the packaged Windows executable. Run `npm run measure:split-processes` for the experiment and `npm run measure:split-processes -- monolithic` for the current-app control. Reports are work/split-process-resources/result.json and monolithic.json. This diagnostic script does not install integrations or alter live provider configuration.
