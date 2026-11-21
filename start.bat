@echo off
rem Punchboard: one-click starter for Windows, from the source.
rem
rem Double-click this file. It builds the companion (the Rust program in
rem server\) and starts it, so it needs Rust; the first run also builds the
rem pages, which needs Node.js. Nothing is installed system-wide and no
rem administrator rights are needed. Most people do not need any of this: the
rem app on the releases page is the same Punchboard, ready to open.
setlocal
cd /d "%~dp0"
title Punchboard

set "RELEASES=https://github.com/GH-Jaider/punchboard/releases/latest"

echo.
echo   Punchboard
echo   ==========
echo.

rem rustup installs here; it is on PATH only in windows opened afterwards.
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

where cargo >nul 2>nul
if errorlevel 1 goto no_cargo

rem The pages (public\js) are built from src\client, once, with Node.js.
if exist "public\js\deck.js" goto run
where npm >nul 2>nul
if errorlevel 1 goto no_node
echo   Building the pages, this only happens once...
call npm ci --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo.
  echo   Something went wrong installing. Check the messages above.
  pause
  exit /b 1
)
call npm run --silent build
if errorlevel 1 (
  echo.
  echo   The build failed. Check the messages above.
  pause
  exit /b 1
)
echo.

:run
echo   Starting (the first time, building takes a few minutes).
echo   Keep this window open while you stream;
echo   close it to stop the deck.
set "PUNCHBOARD_APP_DIR=%~dp0."
cargo run --release --locked --manifest-path server\Cargo.toml
pause
exit /b

:no_cargo
echo   Running Punchboard from the source needs Rust: install it from
echo   https://rustup.rs and double-click this file again.
echo   Most people should install the app instead:
echo   %RELEASES%
echo.
pause
exit /b 1

:no_node
echo   The pages have not been built yet, and building them needs Node.js:
echo   install it from https://nodejs.org and double-click this file again.
echo   Or install the app instead: %RELEASES%
echo.
pause
exit /b 1
