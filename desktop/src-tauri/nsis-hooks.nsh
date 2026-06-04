!macro NSIS_HOOK_PREINSTALL
  ; Stop NoteSci-owned runtime processes before replacing bundled files.
  ; Older test builds could leave postgres.exe/python.exe children running,
  ; which locks DLLs such as pg\bin\icudt67.dll during upgrades.
  Push $R0
  InitPluginsDir
  FileOpen $R0 "$PLUGINSDIR\notesci-stop-runtime.ps1" w
  FileWrite $R0 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $R0 "$$root = [System.IO.Path]::GetFullPath($$env:NOTESCI_INSTALL_DIR).TrimEnd('\','/')$\r$\n"
  FileWrite $R0 "if ([string]::IsNullOrWhiteSpace($$root)) { exit 0 }$\r$\n"
  FileWrite $R0 "Get-CimInstance Win32_Process | Where-Object {$\r$\n"
  FileWrite $R0 "  $$_.ExecutablePath -and [System.IO.Path]::GetFullPath($$_.ExecutablePath).StartsWith($$root, [System.StringComparison]::OrdinalIgnoreCase)$\r$\n"
  FileWrite $R0 "} | Sort-Object ProcessId -Descending | ForEach-Object {$\r$\n"
  FileWrite $R0 "  Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $R0 "}$\r$\n"
  FileWrite $R0 "Start-Sleep -Milliseconds 1500$\r$\n"
  FileClose $R0
  System::Call 'Kernel32::SetEnvironmentVariable(t "NOTESCI_INSTALL_DIR", t "$INSTDIR")i'
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\notesci-stop-runtime.ps1"'

  ; Replace bundled runtime trees on upgrade. User data lives under the app
  ; data directory and is intentionally left untouched.
  RMDir /r "$INSTDIR\pg"
  RMDir /r "$INSTDIR\python"
  RMDir /r "$INSTDIR\backend"
  RMDir /r "$INSTDIR\frontend"
  Sleep 500
  RMDir /r "$INSTDIR\pg"
  RMDir /r "$INSTDIR\python"
  RMDir /r "$INSTDIR\backend"
  RMDir /r "$INSTDIR\frontend"
  Pop $R0
!macroend
