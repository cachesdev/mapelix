@echo off
rem Starts Mapelix: double-click this file, or run it from a terminal.
cd /d "%~dp0"
rem With Mise installed, its Node.js version of the repository is used.
where mise >nul 2>nul
if not errorlevel 1 (
  mise exec -- node scripts\start.mjs %*
  if errorlevel 1 pause
  exit /b
)
where node >nul 2>nul
if errorlevel 1 (
  echo Mapelix needs Node.js 24 or newer. Download it from https://nodejs.org, install it, then start again.
  pause
  exit /b 1
)
node scripts\start.mjs %*
if errorlevel 1 pause
