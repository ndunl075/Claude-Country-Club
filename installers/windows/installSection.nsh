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

StrCpy $cccStage "prepare"
nsExec::ExecToStack '"$PLUGINSDIR\ccc-installer.exe" prepare "$cccTarget"'
Pop $cccResult
Pop $cccDetails
${If} $cccResult != "0"
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
StrCpy $cccStage "commit"
nsExec::ExecToStack '"$PLUGINSDIR\ccc-installer.exe" commit "$cccTarget"'
Pop $cccResult
Pop $cccDetails
${If} $cccResult != "0"
  Goto transaction_failed
${EndIf}
StrCpy $cccStage "registration"
StrCpy $cccResult "registry error"
StrCpy $cccDetails "Windows could not write Country Club's installation registration."
ClearErrors
!insertmacro registryAddInstallInfo
${If} ${Errors}
  Goto transaction_failed
${EndIf}
!insertmacro addStartMenuLink "false"
!insertmacro addDesktopLink "false"
StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
StrCpy $cccStage "finalize"
nsExec::ExecToStack '"$PLUGINSDIR\ccc-installer.exe" finalize "$cccTarget"'
Pop $cccResult
Pop $cccDetails
${If} $cccResult != "0"
  Goto transaction_failed
${EndIf}
!insertmacro customInstall
Goto transaction_done

transaction_failed:
  StrCpy $INSTDIR "$cccTarget"
  SetOutPath "$PLUGINSDIR"
  ; Keep the original stage/result/details separate from the recovery attempt.
  DetailPrint "Installation failed during $cccStage; result: $cccResult"
  DetailPrint "Coordinator details (bounded): $cccDetails"
  nsExec::ExecToStack '"$PLUGINSDIR\ccc-installer.exe" recover "$cccTarget"'
  Pop $cccRecoveryResult
  Pop $cccRecoveryDetails
  DetailPrint "Recovery result: $cccRecoveryResult"
  DetailPrint "Recovery details (bounded): $cccRecoveryDetails"
  IfSilent transaction_abort
  MessageBox MB_OK|MB_ICONEXCLAMATION "Country Club could not complete installation. Your saved rounds and provider settings were preserved.$\r$\n$\r$\nStage: $cccStage$\r$\nResult: $cccResult$\r$\nRecovery result: $cccRecoveryResult$\r$\n$\r$\nIf recovery files remain at $cccTarget.ccc-transaction, keep them for repair and retry this installer.$\r$\n$\r$\nCoordinator details (may be truncated or unreadable):$\r$\n$cccDetails$\r$\n$\r$\nRecovery details (may be truncated or unreadable):$\r$\n$cccRecoveryDetails"
  transaction_abort:
  SetErrorLevel 5
  Abort
transaction_done:
