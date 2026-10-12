; Application replacement section for pinned electron-builder 26.15.3.
; No previous uninstaller is invoked: user data, hooks and registration remain
; available until a validated replacement has been promoted on the same volume.
!include installer.nsh
InitPluginsDir
!insertmacro CHECK_APP_RUNNING
StrCpy $cccTarget "$INSTDIR"
StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!insertmacro setLinkVars
Var /GLOBAL keepShortcuts
StrCpy $keepShortcuts "false"

ExecWait '"$PLUGINSDIR\ccc-installer.exe" prepare "$cccTarget"' $R0
${If} $R0 != 0
  Goto transaction_failed
${EndIf}
StrCpy $INSTDIR "$cccTarget.ccc-transaction\new"
SetOutPath "$INSTDIR"
Var /GLOBAL packageArch
SetCompress off
!insertmacro identify_package
!insertmacro compute_files_for_current_arch
SetCompress "${COMPRESS}"
Nsis7z::Extract "$PLUGINSDIR\app-$packageArch.7z"
!insertmacro custom_files_post_decompression
File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
!ifdef UNINSTALLER_ICON
  File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
!endif
; Move out of the staged directory before attempting directory renames.
SetOutPath "$PLUGINSDIR"
StrCpy $INSTDIR "$cccTarget"
ExecWait '"$PLUGINSDIR\ccc-installer.exe" commit "$cccTarget"' $R0
${If} $R0 != 0
  Goto transaction_failed
${EndIf}
ClearErrors
!insertmacro registryAddInstallInfo
${If} ${Errors}
  Goto transaction_failed
${EndIf}
!insertmacro addStartMenuLink "false"
!insertmacro addDesktopLink "false"
StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
ExecWait '"$PLUGINSDIR\ccc-installer.exe" finalize "$cccTarget"' $R0
${If} $R0 != 0
  Goto transaction_failed
${EndIf}
!insertmacro customInstall
Goto transaction_done

transaction_failed:
  StrCpy $INSTDIR "$cccTarget"
  SetOutPath "$PLUGINSDIR"
  ExecWait '"$PLUGINSDIR\ccc-installer.exe" recover "$cccTarget"' $R1
  IfSilent transaction_abort
  MessageBox MB_OK|MB_ICONEXCLAMATION "Country Club could not complete installation. Your saved rounds and provider settings were preserved. If recovery files remain at $cccTarget.ccc-transaction, keep them for repair and retry this installer."
  transaction_abort:
  SetErrorLevel 5
  Abort
transaction_done:
