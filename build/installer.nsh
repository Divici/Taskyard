; Taskyard NSIS hooks (electron-builder `nsis.include`).
;
; Start with Windows is Electron's login item: a value named after the AppUserModelId
; (com.taskyard.app, src/shared/app-info.ts) under HKCU\...\Run, plus Explorer's matching
; StartupApproved entry. A real uninstall removes both so Windows never tries to start a
; Taskyard.exe that is gone, and the installer copy electron-builder caches for updates in
; %LOCALAPPDATA%\taskyard-updater. An update runs the old uninstaller too (isUpdated): the
; user's choice and the cache are kept then. The user's data (%APPDATA%\Taskyard) always stays.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.taskyard.app"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.taskyard.app"
    RMDir /r "$LOCALAPPDATA\taskyard-updater"
  ${endIf}
!macroend
