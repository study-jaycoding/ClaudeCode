@echo off
setlocal enabledelayedexpansion
REM Higgsfield Spotlight 서버 실행.
REM HF_PORT 환경변수로 포트 변경 가능 (기본 8767).
REM 같은 포트를 점유 중인 옛 python 프로세스가 있으면 자동 종료 후 시작.
REM ※ 그 포트가 다른 프로세스 (브라우저 등) 라면 종료 안 함 — 사용자 의도치 않은 kill 방지.

if "%HF_PORT%"=="" set HF_PORT=8767
echo [start.bat] HF_PORT=%HF_PORT%

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%HF_PORT% ^| findstr LISTENING') do (
    tasklist /FI "PID eq %%a" /NH 2>nul | findstr /R /I "^python" >nul && (
        echo [start.bat] killing previous spotlight process PID=%%a
        taskkill /F /PID %%a >nul 2>nul
    )
)

cd /d "%~dp0backend"
python server.py
pause
