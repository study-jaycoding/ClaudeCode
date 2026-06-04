@echo off
REM Higgsfield Spotlight 업데이트 스크립트
setlocal
cd /d "%~dp0"

echo.
echo === Higgsfield Spotlight 업데이트 ===
echo.

git status --porcelain >nul 2>nul
if errorlevel 1 (
    echo [X] git 저장소가 아니거나 git 이 설치되어 있지 않습니다.
    pause
    exit /b 1
)
for /f %%i in ('git status --porcelain ^| find /c /v ""') do set CHANGES=%%i
if not "%CHANGES%"=="0" (
    echo [!] 로컬 변경 사항 %CHANGES% 건 — 계속하면 충돌 가능
    set /p CONFIRM="계속? (y/N): "
    if /i not "%CONFIRM%"=="y" exit /b 0
)

echo [..] git pull...
git pull
if errorlevel 1 (
    echo [X] git pull 실패
    pause
    exit /b 1
)

echo [..] higgsfield CLI 업데이트...
call npm update -g @higgsfield/cli

echo.
echo === 서버 재시작 필요 ===
echo 실행 중인 server.py 창을 닫고 start.bat 를 다시 실행하세요.
echo.
pause
