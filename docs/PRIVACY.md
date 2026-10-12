# Privacy and local data

This describes the current unsigned preview, not a certification of every client or operating system. See [compatibility](COMPATIBILITY.md) and [acceptance evidence](ACCEPTANCE.md) before enabling an integration.

Country Club runs the game locally. It has no game account, analytics service, model API integration, cloud save, or subscription login. It does not open provider authentication stores, copy login tokens, or submit prompts to verify a subscription. Your coding client continues to control its own authentication, billing and inference usage.

## What the application accesses

| Data | Use and retention |
| --- | --- |
| Golf round and preferences | SQLite in the application's user-data directory. Stores realized course geometry, seed, ball state, score, revisions and quiet-default preferences. |
| Recent shot snapshots | The newest 128 journal entries within 4 MiB of UTF-8 snapshot payloads, pruned during a successful save. The current round is stored separately. This does not cap the entire database or its WAL. |
| Hook stdin | The helper reads at most 256 KiB of the provider's JSON input into process memory. It decodes root/session identity, workspace path, optional turn identity and exact tool name for attention classification. It does not open transcript paths, read source files, or forward prompt text, tool arguments, question contents or plan contents. The bounded raw input can contain these fields before the short-lived helper exits. |
| Normalized lifecycle metadata | Private local IPC carries provider, event category, adapter/protocol version, random event ID, a hashed session/workspace identity and optional provider turn ID. The desktop keeps bounded session/deduplication state in memory. No raw workspace path is forwarded in this event. |
| Connection configuration | Reviewing a connection reads the selected provider configuration: `~/.claude/settings.json` or `~/.codex/hooks.json`. Confirmation adds owned command hooks after checking that the preview is still current. It does not configure providers, models, authentication or permissions. |
| Configuration previews and backups | The preview shows only exact Country Club hook entries. Unrelated settings and third-party hook commands remain in the main process; a full-file hash rejects stale confirmation. **The rollback backup copies the complete original file**, which may contain user-added secrets or sensitive settings. Do not share backup files without reviewing them. They are not diagnostic exports and are not uploaded. |
| Integration ownership | `config-patches.json` records the affected path, owned hook definitions, installation time and backup path. It contains local paths and helper commands. |
| IPC identity/connection files | `identity-key` stores a persistent random installation key. `connection.json` stores a local endpoint, authorization token and a copy of that identity key for the native helper. These are local secrets, not provider credentials. Do not share them. |
| Diagnostics | Up to 80 timestamped diagnostic entries in memory, plus bounded local history under diagnostics-v1. Four chunks retain at most 4 MiB of normalized codes/timestamps; one atomic write stage reserves up to 1 MiB more. Raw messages and identities never enter this disk store. The UI displays a subset. Explicit Settings review/export creates local JSON containing only numeric versions, platform/architecture, status summaries, session-state counts and timestamped allowlisted error codes. Raw messages, paths, session/turn IDs, config, tokens, identity keys and game state are excluded. No upload occurs. Raw helper stderr and arbitrary client version output are not retained. |
| Client version checks | Only an explicit Check version/Choose executable action runs a selected native client with `--version`. The check has a two-second/4 KiB bound, uses an isolated configuration home and omits provider secrets from its environment. Only the parsed version and selected executable path are retained in memory. This is not a subscription check or client compatibility certification. |

Adapter 1.2 derives session identities with HMAC-SHA-256 over provider, session ID and workspace path, using a random 32-byte installation key, and keeps 128 bits of the result. The key persists across restarts; identical raw metadata produces different pseudonyms on independent installations. Invalid key files disable automatic connection without an unsalted fallback and remain preserved for manual review; practice still works. First creation clears an incompatible saved selection from older versions. Deleting/replacing the key changes identities and may require a fresh session selection. These are pseudonyms, not an anonymity guarantee: provider turn IDs are still forwarded unchanged when valid, and an attacker who can read the local key can reproduce the hashes. Neither identifiers nor keys belong in publicly shared diagnostics.

## Where local files remain

The stable application user-data directory normally lives under `%APPDATA%\Claude Country Club` on Windows or `~/Library/Application Support/Claude Country Club` on macOS. Electron also creates normal local caches. Test runs use separate fixture directories; they do not enroll your live clients.

SQLite contains progress and preferences. A successful progress import preserves the previous database as `country-club.sqlite.before-import`. Explicit damaged-storage recovery archives the original database/WAL/SHM family in a uniquely named recovery directory. Configuration connection backups use provider-prefixed `.backup.json` files. Recovery/configuration backups remain local and are not automatically pruned by the shot-history limit.

User-data and IPC files use private-directory/file permissions where supported; Windows IPC uses a current-user pipe ACL. This is access control, not encryption at rest. Anyone who can read your user profile, backups, or unlocked desktop may be able to inspect these files or previews. Country Club does not provide a cloud deletion service.

## Network and desktop behavior

Gameplay assets are bundled. The renderer blocks external network requests, navigation, popups and permission requests. There is no background update check. Explicit documentation/update buttons open fixed GitHub pages in your browser; that browser visit uses its normal network and privacy behavior. A third-party client executable invoked for `--version` is outside Country Club's implementation; the isolated environment is not an OS network sandbox.

Automatic play, sound and login startup are off by default. Automatic windows use inactive show behavior. Country Club does not install global hotkeys, track the active editor, read the clipboard or screen, or request camera, microphone, screen-recording or accessibility access. Its hook returns no provider permission decision. Unknown/disconnected/ambiguous lifecycle state hides automatic play rather than inferring that an agent finished successfully.

Packaged Chromium logging observed zero HTTP/WebSocket URLs during the measured gameplay/lifecycle sample. That evidence is not an OS-level packet audit or a blanket guarantee for every platform, third-party client, browser visit or future version. See [measurement scope](PERFORMANCE.md).

## Your controls

- Use Practice without connecting a provider. Review the owned hook changes and selected configuration path before confirming a connection and complete the provider's own trust review.
- Disable automatic play or quit Country Club to stop automatic gameplay. Existing hooks fail open when the local host is absent; real-provider warnings about missing hook commands remain an unverified surface.
- Remove integrations through Connections before uninstalling. Removal preserves unrelated settings and refuses to discard edited helper references that need manual review.
- Export progress to a chosen local JSON file. It contains game state, not the integration ledger or configuration backups. Treat any imported custom labels as user-provided content before sharing an export.
- Review diagnostic export in Settings before choosing a local destination. Saving uses the exact reviewed snapshot; a newer review replaces the previous one and reviews expire after five minutes. Canceling writes nothing. Reports still disclose versions, status counts and event timing; review them before sharing.
- Uninstall keeps progress by default. Starting a new round replaces the active round; it does not erase configuration backups, recovery archives or all application data. This preview has no comprehensive in-app erase-all-data action. Keep needed exports and remove owned integrations before manually removing app data.

## Remaining release work

Complete local rollback backups remain sensitive by design. Broader network/privacy audits remain open. Keyed identity has native and packaged Windows evidence; it does not establish signed-in client certification or native Mac validation. No claim here makes unsigned artifacts production-ready.

Implementation references: [helper normalization](../native/ccc-hook/main.go), [configuration ownership/backups](../packages/adapters/index.ts), [explicit version inspection](../apps/desktop/src/main/clients.ts), [storage](../apps/desktop/src/main/store.ts), and [desktop lifecycle/security policy](../apps/desktop/src/main/index.ts).

Sleep and screen-lock notifications pause, save and hide gameplay. They are standard Electron powerMonitor events; the app does not inspect the screen or editor to infer these states. Sleep and lock holds are independent, and lifecycle events received while held cannot reopen play or regain trust through a replay after resume/unlock. A fresh turn or explicit post-hold practice is required. Current packaged tests inject these notifications inside the app; actual OS delivery remains a platform validation gate.

At startup, Country Club subscribes to power/lock notifications before creating a window and takes one standard system-state snapshot to recognize an already-locked screen. It does not retain idle duration or poll activity. An unavailable initial lock state pauses automatic play until reliable lock/unlock notification; explicit practice remains available. A known lock/sleep hold suppresses initial windows and recovery/error dialogs as well as later automatic shows.

Local diagnostic history is enabled for the same error codes already displayed in the app. It persists codes/timestamps only; the newest 80 sanitized entries return after restart and can enter an explicitly reviewed export. Four chunks retain up to 4 MiB plus one at-most-1-MiB write stage. The bounded queue may drop older pending errors under overload. Existing malformed, linked, oversized or unexpected files are preserved and disable disk logging while practice/export remain available. A complete synced stage can recover promotion; incomplete stages require manual recovery. Quit gives logging at most 500 ms after gameplay saves, so the most recent diagnostics are not guaranteed after abrupt termination. This adds local storage, not telemetry. Uninstall retains the application data directory, including this history, by default.

Passive Claude StopFailure and Elicitation mappings discard provider error/response text, MCP server names, questions/forms and authentication URLs. They send only the established lifecycle envelope and cannot answer, approve or cancel a request. No ElicitationResult response is interpreted as reliable resumed work. Existing connections require explicit configuration review/trust to add the new mappings; no live configuration was changed by development tests.

