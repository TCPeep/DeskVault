@echo off
rem DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
rem Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
rem Starts Vault in the background and opens it in your browser.
cd /d "%~dp0"
if exist "bin\Vault.exe" (
  start "" "bin\Vault.exe"
  exit /b
)
echo First run: building the Windows helper and starting DeskVault...
set "NODE=node"
if exist "node\node.exe" set "NODE=%~dp0node\node.exe"
if not exist "node\node.exe" (
  where node >nul 2>&1 || (
    echo.
    echo   DeskVault needs Node.js 20 or newer. Install the LTS version from https://nodejs.org
    echo   then double-click Start Vault.cmd again.
    pause
    exit /b 1
  )
)
if not exist "node_modules" (
  echo Installing the viewer libraries, one time only...
  call npm install --omit=dev --no-audit --no-fund || (
    echo   npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
start "Vault server" /min "%NODE%" server.js --open
