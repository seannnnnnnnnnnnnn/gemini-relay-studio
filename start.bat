@echo off
setlocal EnableDelayedExpansion

title Gemini Relay Studio
cd /d "%~dp0"

echo.
echo  +==========================================+
echo  ^|        Gemini Relay Studio             ^|
echo  +==========================================+
echo.

set "LOCAL_NODE=%~dp0node_runtime\node.exe"
set "USE_NODE="

:: ── 1. Use cached portable node.exe if available ─────────
if exist "%LOCAL_NODE%" (
    set "USE_NODE=%LOCAL_NODE%"
    echo [Gemini Relay] Found cached Node.js runtime.
    goto :env_ready
)

:: ── 2. Check system Node.js ───────────────────────────────
where node >nul 2>&1
if not errorlevel 1 (
    for /f %%v in ('node -e "process.stdout.write(String(Number(process.versions.node.split(chr(46))[0])))"') do set "SYS_MAJOR=%%v"
    if !SYS_MAJOR! GEQ 24 (
        echo [Gemini Relay] System Node.js v!SYS_MAJOR! detected.
        set "USE_NODE=node"
        goto :env_ready
    )
    echo [Gemini Relay] System Node.js v!SYS_MAJOR! is too old (need v24+). Downloading portable version...
) else (
    echo [Gemini Relay] Node.js not found. Downloading portable runtime (~30MB)...
)

echo [Gemini Relay] This only happens once. Please wait...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_setup_node.ps1"

if errorlevel 1 (
    echo.
    echo [ERROR] Auto-download failed. Please install Node.js 24 manually:
    echo         https://nodejs.org/en/download
    echo.
    pause
    exit /b 1
)

set "USE_NODE=%LOCAL_NODE%"

:env_ready
:: ── 3. Create .env on first run ───────────────────────────
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo.
        echo  [First Run] Open the browser panel on the left side,
        echo  fill in your OneAPI URL and Key, then click Save.
        echo.
    )
)

:: ── 4. Read port from .env ────────────────────────────────
set "PORT=4310"
if exist ".env" (
    for /f "tokens=1,* delims==" %%a in ('findstr /b "PORT=" .env 2^>nul') do (
        set "RAW_PORT=%%b"
        if not "!RAW_PORT!"=="" set "PORT=!RAW_PORT!"
    )
)

:: ── 5. Start server ───────────────────────────────────────
echo [Gemini Relay] Starting server... Press Ctrl+C to stop.
echo [Gemini Relay] Open in browser: http://localhost:%PORT%
echo.

start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:%PORT%"

"%USE_NODE%" --no-warnings server\index.js

if errorlevel 1 (
    echo.
    echo [ERROR] Server exited unexpectedly. See error above.
    pause
)
