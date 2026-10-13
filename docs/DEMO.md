# Demo walkthrough

A five-minute run-through of Claude Country Club on Windows.

## Before the demo

1. Install `Claude-Country-Club-Setup-0.1.0-x64.exe`. The installer is unsigned, so Windows SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**.
2. Open Claude Country Club from the Start menu. It lives in the system tray.
3. Open **Connections**, choose **Review connection** for Claude Code, check the preview of the hook entries, then choose **Confirm connection**.
4. Start a new Claude Code session so it loads the new hooks. If Claude Code asks you to review hooks, approve the Country Club entries.
5. In **Settings**, turn on **Open automatically while my agent works**. It is off by default. The game shows 2 seconds after a turn starts (adjustable from 1 to 30 seconds).

## The demo

1. **Start a real turn.** In a terminal, ask Claude Code something that takes a little while, for example "read this repo and summarize the architecture".
2. **The course appears** beside your terminal without stealing keyboard focus. Click the course to play. Pull back from the ball and release to shoot.
3. **Claude finishes or asks for permission.** The game freezes, saves and tucks itself away so you can get back to work.
4. **Start another turn.** The same round comes back exactly where you left it.

## Backup: synthetic demo

If the live hookup misbehaves, open Country Club, go to **Connections**, and use **Demo start**, **Demo attention** and **Demo stop**. They drive the same show, freeze and hide behavior without a real coding client. The app labels these events as synthetic.

You can also choose **Practice a round** from the tray menu at any time.

## Known limits in this preview

- Unsigned installers: expect SmartScreen on Windows and Gatekeeper on macOS.
- The macOS packages have been built and checked in CI but not yet tested on a real Mac.
- Only the Claude Code and Codex command-line clients are supported. The Claude desktop app, IDE extensions and cloud sessions are not detected yet.
- Pressing Esc to interrupt Claude Code does not send a hook event, so the game may stay up until the next event.
