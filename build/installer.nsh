; Windows: the privileged helper runs as a SYSTEM scheduled task started at boot.
; (A plain Node process cannot answer the Service Control Manager, so a classic service would
; need a wrapper; a SYSTEM task gives the same privileges and lifetime without one.)
; resources\helper.cmd sets ELECTRON_RUN_AS_NODE=1 and runs the app exe with out\main\helper.js.

!macro customInstall
  ; Directories the helper may access: the installing user's profiles and per-connection temp dirs.
  SetShellVarContext current
  StrCpy $0 "$APPDATA\Multi OpenVPN\profiles"
  StrCpy $1 "$TEMP\multi-openvpn"
  SetShellVarContext all ; from here $APPDATA = C:\ProgramData (where the helper keeps its config)
  ; OpenVPN binary: the bundled one if present, otherwise the OpenVPN Community install.
  StrCpy $2 "$INSTDIR\resources\openvpn\win-x64\openvpn.exe"
  IfFileExists "$2" +2 0
    StrCpy $2 "$PROGRAMFILES64\OpenVPN\bin\openvpn.exe"
  ReadEnvStr $3 USERNAME

  ; Write helper.json + token (helper validates the binary and pins its SHA-256).
  nsExec::ExecToLog '"$INSTDIR\resources\helper.cmd" --setup-args --root "$0" --root "$1" --binary "$2"'
  ; Only the installing user (plus SYSTEM/Administrators) may read the token; config is admin-only.
  nsExec::ExecToLog 'icacls "$APPDATA\MultiOpenVPN\token" /inheritance:r /grant:r "$3:R" /grant:r "SYSTEM:F" /grant:r "Administrators:F"'
  nsExec::ExecToLog 'icacls "$APPDATA\MultiOpenVPN\helper.json" /inheritance:r /grant:r "SYSTEM:F" /grant:r "Administrators:F"'

  nsExec::ExecToLog 'schtasks /Delete /TN "MultiOpenVPN Helper" /F'
  nsExec::ExecToLog 'schtasks /Create /TN "MultiOpenVPN Helper" /TR "\"$INSTDIR\resources\helper.cmd\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F'
  nsExec::ExecToLog 'schtasks /Run /TN "MultiOpenVPN Helper"'
!macroend

!macro customUnInstall
  SetShellVarContext all
  nsExec::ExecToLog 'schtasks /End /TN "MultiOpenVPN Helper"'
  nsExec::ExecToLog 'schtasks /Delete /TN "MultiOpenVPN Helper" /F'
  RMDir /r "$APPDATA\MultiOpenVPN"
!macroend
