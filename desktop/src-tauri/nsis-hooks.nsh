!macro NSIS_HOOK_PREINSTALL
  ; Replace bundled runtime trees on upgrade. Older test builds used the same
  ; app version and could leave a partial embedded Postgres/Python tree behind.
  RMDir /r "$INSTDIR\pg"
  RMDir /r "$INSTDIR\python"
  RMDir /r "$INSTDIR\backend"
  RMDir /r "$INSTDIR\frontend"
!macroend
