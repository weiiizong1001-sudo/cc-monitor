@echo off
chcp 65001 >nul
REM ============================================================
REM  cc-monitor Connector - Windows build script (single-file exe)
REM  Output: dist\cc-monitor-connector.exe (no Python needed on target)
REM
REM  Prereq: Python 3.8+ installed, and run once:
REM      pip install paramiko pyinstaller
REM ============================================================

where pyinstaller >nul 2>nul
if errorlevel 1 (
    echo [build] pyinstaller not found, installing...
    pip install pyinstaller
    if errorlevel 1 (
        echo [build] Failed to install pyinstaller. Make sure Python/pip is available.
        pause
        exit /b 1
    )
)

where paramiko >nul 2>nul
if errorlevel 1 (
    echo [build] paramiko not found, installing...
    pip install paramiko
)

echo [build] Building (--onefile --noconsole)...
pyinstaller --onefile --noconsole --name cc-monitor-connector --collect-all paramiko --collect-all cryptography --clean --noconfirm connector.py

if errorlevel 1 (
    echo.
    echo [build] FAILED. To debug startup errors, temporarily drop --noconsole:
    echo     pyinstaller --onefile --name cc-monitor-connector --clean --noconfirm connector.py
    pause
    exit /b 1
)

echo.
echo [build] DONE: %cd%\dist\cc-monitor-connector.exe
echo [build] Distribute: put dist\cc-monitor-connector.exe and connector_config.json in the SAME folder.
echo [build] Edit connector_config.json (backend_key_path etc.) then double-click the exe.
pause
