@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d %~dp0\..

set "OCTOP_PORTS="
for /f "usebackq delims=" %%I in (`node .\scripts\print-local-agent-ports.mjs`) do (
  if defined OCTOP_PORTS (
    set "OCTOP_PORTS=!OCTOP_PORTS! %%I"
  ) else (
    set "OCTOP_PORTS=%%I"
  )
)

if not defined OCTOP_PORTS (
  echo [OctOP] Failed to resolve local-agent ports. Starting without pre-stop.
  node .\scripts\run-local-agent.mjs %*
  exit /b %ERRORLEVEL%
)

set "OCTOP_KILLED_ANY="
for %%P in (!OCTOP_PORTS!) do call :stop_port %%P

if defined OCTOP_KILLED_ANY (
  timeout /t 1 /nobreak >nul
)

node .\scripts\run-local-agent.mjs %*
exit /b %ERRORLEVEL%

:stop_port
set "PORT=%~1"
if "%PORT%"=="" exit /b 0

for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  call :stop_pid %%I %PORT%
)
exit /b 0

:stop_pid
set "PID=%~1"
set "PORT=%~2"

if "%PID%"=="" exit /b 0
if "%PID%"=="0" exit /b 0
if defined OCTOP_STOPPED_PID_%PID% exit /b 0

set "OCTOP_STOPPED_PID_%PID%=1"
set "OCTOP_KILLED_ANY=1"

echo [OctOP] Stopping PID %PID% on port %PORT%...
taskkill /PID %PID% /T /F >nul 2>&1
if errorlevel 1 (
  echo [OctOP] Failed to stop PID %PID%. Launcher will try a fallback port if needed.
) else (
  echo [OctOP] Stop signal sent to PID %PID%.
)
exit /b 0
