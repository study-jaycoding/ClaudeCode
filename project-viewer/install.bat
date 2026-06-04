@echo off
REM ─────────────────────────────────────────────────────────────
REM  Project Viewer 최초 설치 스크립트
REM  - Python 3.10+ 필요 (없으면 https://python.org 에서 설치)
REM  - .env 파일 자동 생성 (.env.example → .env 복사)
REM ─────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0"

echo.
echo === Project Viewer 설치 ===
echo.

REM 1) Python 체크
where python >nul 2>nul
if errorlevel 1 (
    echo [X] Python 이 설치되어 있지 않습니다.
    echo     https://python.org 에서 Python 3.10 이상 설치 후 다시 실행하세요.
    pause
    exit /b 1
)
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PY_VER=%%v
echo [OK] Python %PY_VER%

REM 2) .env 파일 생성 (없으면 .env.example 복사)
if not exist ".env" (
    if exist ".env.example" (
        copy /Y ".env.example" ".env" >nul
        echo [OK] .env 파일 생성됨 — 필요 시 메모장으로 편집:
        echo      notepad "%CD%\.env"
    ) else (
        echo [!] .env.example 파일이 없습니다. 수동 생성 필요.
    )
) else (
    echo [OK] .env 파일 이미 존재 (유지)
)

REM 3) 데이터 폴더 안내
echo.
echo === 다음 단계 ===
echo 1) .env 파일을 열어 CCDATA_DIR 을 팀 공유 경로로 바꾸세요 (옵션)
echo 2) start.bat 더블클릭으로 서버 시작
echo 3) 브라우저에서 http://127.0.0.1:8766 접속
echo.
echo Higgsfield Spotlight 도 함께 쓰려면:
echo   - https://nodejs.org 에서 Node.js 설치
echo   - npm install -g @higgsfield/cli
echo   - higgsfield auth login  (브라우저로 로그인)
echo   - ..\higgsfield-spotlight\install.bat 실행
echo.
pause
