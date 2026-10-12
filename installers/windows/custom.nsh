; These actions affect Country Club only. Provider integration is an explicit
; user-scoped action inside the app, never an installer side effect.
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "WinVer.nsh"

!macro customHeader
  ; The standard template still defines its old-uninstaller functions. Our
  ; transaction section deliberately leaves those unused; strip them normally.
  !pragma warning disable 6010
  ; Keep electron-builder's standard signed-uninstaller generation. Its pinned
  ; main script includes our transaction section from this working directory.
  !addincludedir "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis"
  !cd "${PROJECT_DIR}\installers\windows"
  !ifndef BUILD_UNINSTALLER
    Var cccTarget
    Function .onGUIEnd
      ${If} $cccTarget != ""
        ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
        ${If} $R0 != 0
          SetOutPath "$PLUGINSDIR"
          ExecWait '"$PLUGINSDIR\ccc-installer.exe" recover "$cccTarget"' $R0
        ${EndIf}
      ${EndIf}
    FunctionEnd
  !endif
!macroend

!macro customCheckAppRunning
  ; Never force-kill a game with an unacknowledged shot. A silent install
  ; fails cleanly; an interactive install can request a saved app shutdown.
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    IfSilent running_abort
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Country Club is running. Press OK to save the round and close Country Club before continuing. Your coding agents will keep working." IDOK running_close
    Goto running_abort
    running_close:
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 running_abort
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --ccc-installer-quit' $R0
    StrCpy $R1 0
    running_wait:
    Sleep 250
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 != 0
      Goto running_done
    ${EndIf}
    IntOp $R1 $R1 + 1
    IntCmp $R1 20 running_abort running_wait running_abort
    running_abort:
    SetErrorLevel 2
    Quit
  ${EndIf}
  running_done:
!macroend

!macro customInit
  ${If} $installMode != "CurrentUser"
    IfSilent user_scope_abort
    MessageBox MB_OK|MB_ICONEXCLAMATION "Country Club installs only for the current user. All-users installation is not supported."
    user_scope_abort:
    SetErrorLevel 6
    Quit
  ${EndIf}
  ; The template's legacy OS check allows Windows 7/8, which this Electron
  ; runtime does not support. Reject before changing any installed files.
  ${IfNot} ${AtLeastWin10}
    IfSilent incompatible_os
    MessageBox MB_OK|MB_ICONEXCLAMATION "Country Club requires 64-bit Windows 10 or later. No application files or provider settings were changed."
    incompatible_os:
    SetErrorLevel 3
    Quit
  ${EndIf}
  InitPluginsDir
  File /oname=$PLUGINSDIR\ccc-installer.exe "${PROJECT_DIR}\work\nsis\ccc-installer.exe"
  SetOutPath "$PLUGINSDIR"
  StrCpy $cccTarget "$INSTDIR"
  ; Never recover files underneath a running game, including silent retries.
  IfFileExists "$cccTarget.ccc-transaction\journal.json" 0 no_pending_transaction
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      SetErrorLevel 2
      Quit
    ${EndIf}
    ExecWait '"$PLUGINSDIR\ccc-installer.exe" recover "$cccTarget"' $R0
    ${If} $R0 != 0
      IfSilent recovery_abort
      MessageBox MB_OK|MB_ICONEXCLAMATION "Automatic recovery could not finish. Keep $cccTarget and $cccTarget.ccc-transaction unchanged for manual review. Saved rounds and provider settings were not changed."
      recovery_abort:
      SetErrorLevel 5
      Quit
    ${EndIf}
  no_pending_transaction:
  ; Prevent an older app from opening a newer save schema. Same-version
  ; repair is allowed. Versions are numeric release versions, not prereleases.
  ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $R0 != ""
    ${VersionCompare} "$R0" "${VERSION}" $R1
    ${If} $R1 == 1
      IfSilent downgrade_abort
      MessageBox MB_OK|MB_ICONEXCLAMATION "A newer Country Club version ($R0) is installed. Use its installer to repair it. Your app and progress were preserved."
      downgrade_abort:
      SetErrorLevel 4
      Quit
    ${EndIf}
  ${EndIf}
  ${GetParameters} $R0
  ${GetOptions} $R0 "/REPAIR" $R1
  ${IfNot} ${Errors}
    DetailPrint "Repairing Country Club application files; progress and provider settings will be preserved."
  ${EndIf}
!macroend

!macro customInstall
  DetailPrint "Country Club installed. Connect an existing signed-in agent from the application's Connections screen."
!macroend

!macro customUnInstall
  ; Upgrades must retain hook definitions and progress. Cleanup is only for
  ; explicit uninstall; failure aborts before any application files disappear.
  ${If} ${isUpdated}
    Goto cleanup_done
  ${EndIf}
  IfFileExists "$INSTDIR\resources\ccc-hook.exe" 0 cleanup_done
  ExecWait '"$INSTDIR\resources\ccc-hook.exe" --cleanup --data-dir "$APPDATA\Claude Country Club"' $R0
  ${If} $R0 != 0
    IfSilent cleanup_abort
    MessageBox MB_OK|MB_ICONEXCLAMATION "Country Club could not safely remove modified integration entries. Your provider settings and installed app were preserved. Remove Country Club hooks from your client settings before uninstalling."
    cleanup_abort:
    SetErrorLevel 2
    Abort
  ${EndIf}
  cleanup_done:
!macroend
