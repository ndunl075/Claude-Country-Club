# Rules for parallel worker sessions

Several Claude Code sessions may work on this repository at once. Each one follows these rules.

## Worktrees and branches

- Work only in your own git worktree and branch. Never edit the main checkout at `Documents/Claude-Country-Club`.
- Touch only the files your brief says you own. If you need to change a file someone else owns, stop and report back instead of editing it.
- Before deleting any folder, check it for junctions or symlinks (`node_modules`, packaged app output, test profiles). Remove the links first, then the folder. Never `rm -rf` a folder that still contains a junction.

## Exclusive machine resources

The installed app, its named pipes, the `HKCU\...\Uninstall` registration and the real Electron singleton lock are shared by every session on this machine.

- Before running any local installed/packaged acceptance (`test:installer*`, `test:upgrade`, `test:attention-delivery`, `test:full-round`, `measure:*`), create the lock file `%TEMP%\ccc-machine.lock` containing your branch name. If it already exists, don't run the test. Use CI instead, or wait.
- Delete the lock when you finish, including after a failure.
- Prefer CI (`Desktop verification` workflow) for installer and GUI suites. Local runs that open windows are allowed only when your brief says so, because Nico may be using this computer.
- Never touch Nico's real `~/.claude` or `~/.codex` configuration. Use the private test homes the scripts already create.

## Evidence and docs

- Don't append to `PROGRESS.md` or `docs/ACCEPTANCE.md`. The lead session updates those after merging.
- Put your evidence summary in the PR description, and any long notes in `docs/evidence/<your-branch>.md`.

## Updating an open PR

- Bring a PR branch up to date by merging `main` into it. Never rebase and force-push a branch that has an open PR.

## Review gate

- Changes touching persistence, SQLite/journal code, install transactions, hook config writers, crypto/identity keys, permissions or crash recovery stop at an open PR. The lead session reviews and merges them.
- Test-only, CI, docs and UI changes may self-merge once CI is fully green on the PR's exact head SHA, if your brief allows it.
- A PR's base branch must be `main`.
