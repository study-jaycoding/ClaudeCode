@echo off
REM ─────────────────────────────────────────────────────────────
REM  Project Viewer 업데이트 스크립트
REM  - git pull 로 최신 코드 받음
REM  - 서버 자동 종료 → 재시작
REM ─────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0"

echo.
echo === Project Viewer 업데이트 ===
echo.

REM 1) 로컬 변경 사항 경고
git status --porcelain >nul 2>nul
if errorlevel 1 (
    echo [X] git 저장소가 아니거나 git 이 설치되어 있지 않습니다.
    pause
    exit /b 1
)
for /f %%i in ('git status --porcelain ^| find /c /v ""') do set CHANGES=%%i
if not "%CHANGES%"=="0" (
    echo [!] 로컬에 커밋되지 않은 변경 사항이 %CHANGES% 건 있습니다.
    echo     계속하면 충돌이 발생할 수 있습니다.
    set /p CONFIRM="계속하시겠습니까? (y/N): "
    if /i not "%CONFIRM%"=="y" exit /b 0
)

REM 2) git pull
echo [..] 최신 코드 받는 중...
git pull
if errorlevel 1 (
    echo [X] git pull 실패. 충돌을 해결한 뒤 다시 실행하세요.
    pause
    exit /b 1
)
echo [OK] 코드 업데이트 완료

REM 3) 서버 재시작 (8766 포트 사용 중인 python 프로세스만 정확히 종료하기 어렵기에
REM    사용자에게 안내)
echo.
echo === 서버 재시작 필요 ===
echo 실행 중인 server.py 창을 닫고 start.bat 를 다시 실행하세요.
echo.
pause
