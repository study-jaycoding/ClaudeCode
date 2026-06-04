@echo off
setlocal enabledelayedexpansion
REM 프로젝트 뷰어 + Higgsfield Spotlight 통합 서버
REM 더블클릭하면 backend/server.py 가 기동된다.
REM PV_PORT 환경변수로 포트 변경 가능 (기본 8766).
REM 같은 포트를 점유 중인 옛 PV(python) 프로세스가 있으면 자동 종료 후 시작.
REM ※ 그 포트가 다른 프로세스 (브라우저 등) 라면 종료 안 함 — 사용자 의도치 않은 kill 방지.

if "%PV_PORT%"=="" set PV_PORT=8766
echo [start.bat] PV_PORT=%PV_PORT%

REM 그 포트를 listening 중인 PID 들 중 python.exe / pythonw.exe 만 안전하게 종료.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%PV_PORT% ^| findstr LISTENING') do (
    tasklist /FI "PID eq %%a" /NH 2>nul | findstr /R /I "^python" >nul && (
        echo [start.bat] killing previous PV process PID=%%a
        taskkill /F /PID %%a >nul 2>nul
    )
)

cd /d "%~dp0backend"
python server.py
pause
