@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] Starting sync >> logs\sync.log 2>&1
npm run sync >> logs\sync.log 2>&1
set "SYNC_EXIT_CODE=%ERRORLEVEL%"
if not "%SYNC_EXIT_CODE%"=="0" (
  echo [%date% %time%] Sync failed with exit code %SYNC_EXIT_CODE% >> logs\sync.log 2>&1
  exit /b %SYNC_EXIT_CODE%
)
echo [%date% %time%] Sync complete >> logs\sync.log 2>&1
