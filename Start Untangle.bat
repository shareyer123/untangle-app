@echo off
rem Double-click to update Untangle from GitHub and start it.
rem Works from the untangle folder, or from a copy/shortcut elsewhere if the app is in %USERPROFILE%\untangle.
set "APP=%~dp0"
if not exist "%APP%package.json" set "APP=%USERPROFILE%\untangle\"
if not exist "%APP%package.json" (
  echo Cannot find the Untangle folder.
  echo Expected it next to this file or at %USERPROFILE%\untangle
  echo.
  pause
  exit /b 1
)
cd /d "%APP%"

echo Checking for updates...
git pull --ff-only
if errorlevel 1 (
  echo.
  echo Could not update. Starting the version already on this computer.
  echo.
)

where electron >nul 2>nul
if %errorlevel%==0 (
  electron .
) else (
  npx --yes electron@44.9.3 .
)
