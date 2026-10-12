#!/bin/bash
# User-scoped cleanup. Never invoke this script with sudo.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
if [ "$(/usr/bin/id -u)" = "0" ]; then
  printf '%s\n' 'Run this assistant as the logged-in user, without sudo. No files were changed.' >&2
  exit 2
fi
if [ "$(/usr/bin/uname -s)" != Darwin ]; then
  printf '%s\n' 'This removal assistant runs on macOS only.' >&2
  exit 2
fi
resources=$(cd -P -- "$(dirname -- "$0")" && pwd -P)
app=$(cd -P -- "$resources/../.." && pwd -P)
if [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" != com.countryclub.desktop ] || [ ! -x "$resources/ccc-hook" ]; then
  printf '%s\n' 'The bundled application or cleanup helper could not be verified. App files were preserved.' >&2
  exit 2
fi
case "$app" in *.app) ;; *) printf '%s\n' 'Unexpected application location. App files were preserved.' >&2; exit 2 ;; esac
data="$HOME/Library/Application Support/Claude Country Club"
action=remove
case "${1-}" in
  --check) printf '%s\n' 'Removal assistant is bundled correctly. No files were changed.'; exit 0 ;;
  --cleanup-only) action=cleanup ;;
  '') ;;
  *) printf '%s\n' 'Usage: Uninstall-Claude-Country-Club.command [--check|--cleanup-only] [--yes]' >&2; exit 2 ;;
esac
if [ "${2-}" != --yes ]; then
  printf '%s\n' 'Quit Claude Country Club first. This disconnects unchanged Country Club hooks for your user.' 'Saved golf progress, backups, and all provider authentication are kept.'
  if [ "$action" = remove ]; then printf '%s\n' 'After safe cleanup, Finder will move this app to Trash.'; fi
  printf '%s' 'Continue? [y/N] '
  read -r response || exit 1
  case "$response" in y|Y|yes|YES) ;; *) printf '%s\n' 'Canceled. No files were changed.'; exit 1 ;; esac
fi
app_running() {
  while IFS= read -r command; do
    case "$command" in "$app/Contents/MacOS/"*) return 0 ;; esac
  done < <(/bin/ps -axo command=)
  return 1
}
if app_running; then
  printf '%s\n' 'Country Club is running. Quit it normally, then retry. No processes were stopped.' >&2
  exit 2
fi
if ! "$resources/ccc-hook" --cleanup --data-dir "$data"; then
  printf '%s\n' 'Some integration entries were modified, inaccessible, or could not be removed safely.' 'The app and ownership ledger were preserved. Review Connections or restore/remove owned helper references and retry.' >&2
  exit 2
fi
if [ "$action" = cleanup ]; then printf '%s\n' 'Integrations disconnected. App and saved progress were preserved.'; exit 0; fi
# Finder handles normal macOS Trash permissions. The native cleanup never runs elevated.
if ! /usr/bin/osascript - "$app" <<'APPLESCRIPT'
on run argv
  set applicationFile to POSIX file (item 1 of argv)
  tell application "Finder" to delete applicationFile
end run
APPLESCRIPT
then
  printf '%s\n' 'Integrations are disconnected. Move the app to Trash in Finder to finish removal. Saved progress remains.' >&2
  exit 3
fi
printf '%s\n' 'Claude Country Club was moved to Trash. Saved golf progress and backups were kept.' 'Apple package receipts are retained as install history; reinstalling or upgrading remains supported.'
