@echo off
rem Punchboard: one-click starter for Windows.
rem
rem Double-click this file. The first run downloads its own copy of Node.js
rem into .\runtime (checked against the official checksums), installs
rem dependencies, then starts the companion. Nothing is installed system-wide
rem and no administrator rights are needed. Later runs start straight away.
setlocal
cd /d "%~dp0"
title Punchboard

set "NODE_VERSION=24.15.0"
set "NODE_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "NODE_ARCH=arm64"
set "NODE_HOME=%~dp0runtime\node-v%NODE_VERSION%-win-%NODE_ARCH%"

echo.
echo   Punchboard
echo   ==========
echo.

if exist "%NODE_HOME%\node.exe" goto have_node
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-node.ps1" -Version %NODE_VERSION% -Arch %NODE_ARCH% -Dest "%~dp0runtime"
if exist "%NODE_HOME%\node.exe" goto have_node

rem Offline on the first run: fall back to a Node the PC already has.
rem It must be 22.18 or newer, which runs TypeScript directly.
where node >nul 2>nul
if errorlevel 1 goto no_node
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)"
if errorlevel 1 goto no_node
echo   Could not download Node.js, so the one already on this PC will be used.
goto install

:no_node
echo.
echo   Node.js could not be downloaded. Check the internet connection and
echo   double-click this file again. This is only needed the first time.
echo.
pause
exit /b 1

:have_node
set "PATH=%NODE_HOME%;%PATH%"

:install
rem A release zip ships the built pages in public\js; a source checkout does
rem not, so it also needs the build tools and one build.
set "INSTALL_FLAGS=--omit=dev"
if not exist "public\js\deck.js" set "INSTALL_FLAGS="
if exist "node_modules\.installed" if exist "public\js\deck.js" goto run
echo   Installing Punchboard's parts, this only happens once...
call npm ci %INSTALL_FLAGS% --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo.
  echo   Something went wrong installing. Check the messages above.
  pause
  exit /b 1
)
type nul > "node_modules\.installed"
if exist "public\js\deck.js" goto installed
echo   Building the pages...
call npm run --silent build
if errorlevel 1 (
  echo.
  echo   The build failed. Check the messages above.
  pause
  exit /b 1
)
:installed
echo.

:run
echo   Starting. Keep this window open while you stream;
echo   close it to stop the deck.
node src\server\main.ts
pause
