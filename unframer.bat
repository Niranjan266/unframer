@echo off
REM ============================================================================
REM  Unframer - Windows launcher
REM
REM  Double-click to start the web UI, or run from a terminal:
REM
REM    unframer.bat                                 start the web UI
REM    unframer.bat https://site.framer.website/    export a site to .\out
REM    unframer.bat verify https://site.../         check .\out against the original
REM    unframer.bat test                            run the test suite
REM    unframer.bat help                            show this help
REM
REM  Set a different port with:  set PORT=5000 && unframer.bat
REM ============================================================================

setlocal EnableDelayedExpansion

REM Always run from the folder this script lives in, so double-clicking works
REM regardless of where Explorer thinks the working directory is.
cd /d "%~dp0"

if "%PORT%"=="" set "PORT=4180"

REM ---------------------------------------------------------------- Node check
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Node.js was not found.
    echo.
    echo   Unframer needs Node.js 20 or newer. Install it from:
    echo       https://nodejs.org/
    echo.
    echo   Then run this file again.
    echo.
    pause
    exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODEMAJOR=%%v"
if !NODEMAJOR! LSS 20 (
    echo.
    echo   Node.js 20 or newer is required.
    for /f %%v in ('node -p "process.versions.node"') do echo   Found version %%v
    echo.
    echo   Update from https://nodejs.org/ and run this file again.
    echo.
    pause
    exit /b 1
)

REM -------------------------------------------------------- First-run install
if not exist "node_modules\" (
    echo.
    echo   First run - installing dependencies. This takes a minute.
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo   Dependency installation failed. Check the messages above.
        echo.
        pause
        exit /b 1
    )
)

REM --------------------------------------------------------------- Dispatch
set "CMD=%~1"

if /i "%CMD%"=="help"    goto :help
if /i "%CMD%"=="--help"  goto :help
if /i "%CMD%"=="/?"      goto :help
if /i "%CMD%"=="test"    goto :test
if /i "%CMD%"=="verify"  goto :verify
if /i "%CMD%"=="serve"   goto :serve
if "%CMD%"==""           goto :serve
goto :export


REM ============================================================== web UI
:serve
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo.
    echo   Port %PORT% is already in use.
    echo   Start on a different one, for example:
    echo.
    echo       set PORT=5000 ^&^& unframer.bat
    echo.
    pause
    exit /b 1
)

echo.
echo   Starting Unframer on http://localhost:%PORT%/
echo   Your browser will open shortly. Press Ctrl+C here to stop.
echo.

REM Open the browser once the server has had time to bind. PowerShell handles
REM the delay because `timeout` cannot be chained cleanly inside `start`.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:%PORT%/'"

call npx tsx src/cli.ts serve --port %PORT%
goto :eof


REM ============================================================== export
:export
echo.
echo   Exporting %CMD%
echo   Assets are downloaded for a fully portable copy, so this may take a while.
echo.

call npx tsx src/cli.ts "%CMD%" --out out --offline --package %2 %3 %4 %5 %6 %7 %8 %9
if errorlevel 1 (
    echo.
    echo   Export failed. Check the messages above.
    echo.
    pause
    exit /b 1
)

echo.
echo   Done. Opening the output folder.
echo   Open index.html inside it to view the site.
echo.
start "" explorer "%CD%\out"
pause
goto :eof


REM ============================================================== verify
:verify
if "%~2"=="" (
    echo.
    echo   Usage: unframer.bat verify https://your-site.framer.website/
    echo.
    pause
    exit /b 1
)

echo.
echo   Verifying .\out against %~2
echo   Downloading a browser on first use, which takes a few minutes.
echo.
call npx playwright install chromium
call npx tsx src/cli.ts verify "%~2" --export out
pause
goto :eof


REM ============================================================== test
:test
echo.
echo   Running the test suite.
echo.
call npm run check
pause
goto :eof


REM ============================================================== help
:help
echo.
echo   Unframer - convert a published Framer site into portable HTML
echo.
echo   unframer.bat                                 Start the web UI
echo   unframer.bat https://site.framer.website/    Export a site to .\out
echo   unframer.bat verify https://site.../         Check .\out against the original
echo   unframer.bat test                            Run the test suite
echo   unframer.bat help                            Show this help
echo.
echo   Change the port:   set PORT=5000 ^&^& unframer.bat
echo.
pause
goto :eof
