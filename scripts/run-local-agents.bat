@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d %~dp0\..

set "OCTOP_PORTS="
set "OCTOP_PORTS_FILE=%TEMP%\octop-local-agent-ports-%RANDOM%-%RANDOM%.tmp"
node .\scripts\print-local-agent-ports.mjs >"%OCTOP_PORTS_FILE%"
set "OCTOP_PORTS_EXIT=%ERRORLEVEL%"

for /f "usebackq delims=" %%I in ("%OCTOP_PORTS_FILE%") do (
  if defined OCTOP_PORTS (
    set "OCTOP_PORTS=!OCTOP_PORTS! %%I"
  ) else (
    set "OCTOP_PORTS=%%I"
  )
)

if exist "%OCTOP_PORTS_FILE%" del /q "%OCTOP_PORTS_FILE%" >nul 2>&1

if not "%OCTOP_PORTS_EXIT%"=="0" (
  echo [OctOP] local-agent 포트 조회에 실패해서 시작을 중단합니다.
  exit /b %OCTOP_PORTS_EXIT%
)

if not defined OCTOP_PORTS (
  echo [OctOP] local-agent 포트를 확인하지 못해서 시작을 중단합니다.
  exit /b 1
)

set "OCTOP_KILLED_ANY="
for %%P in (!OCTOP_PORTS!) do call :stop_port %%P

call :ensure_ports_released !OCTOP_PORTS!

if defined OCTOP_BLOCKED_PORTS (
  echo [OctOP] 다음 포트를 해제하지 못해서 local-agent 시작을 중단합니다: !OCTOP_BLOCKED_PORTS!
  exit /b 1
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

:ensure_ports_released
set "OCTOP_BLOCKED_PORTS="

for /l %%T in (1,1,10) do (
  set "CURRENT_BLOCKED_PORTS="
  for %%P in (%*) do call :append_busy_port %%P

  if not defined CURRENT_BLOCKED_PORTS (
    exit /b 0
  )

  >nul timeout /t 1 /nobreak
)

set "OCTOP_BLOCKED_PORTS=%CURRENT_BLOCKED_PORTS%"
for %%P in (!OCTOP_BLOCKED_PORTS!) do (
  echo [OctOP] Port %%P가 여전히 사용 중입니다.
)
exit /b 0

:append_busy_port
set "PORT=%~1"
if "%PORT%"=="" exit /b 0

set "PORT_BUSY="
for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  set "PORT_BUSY=1"
)

if not defined PORT_BUSY exit /b 0

if defined CURRENT_BLOCKED_PORTS (
  set "CURRENT_BLOCKED_PORTS=!CURRENT_BLOCKED_PORTS! %PORT%"
) else (
  set "CURRENT_BLOCKED_PORTS=%PORT%"
)
exit /b 0
