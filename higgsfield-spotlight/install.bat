@echo off
REM ─────────────────────────────────────────────────────────────
REM  Higgsfield Spotlight 최초 설치 스크립트
REM  - Python 3.10+ 필요
REM  - Node.js + @higgsfield/cli 필요
REM ─────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0"

echo.
echo === Higgsfield Spotlight 설치 ===
echo.

REM 1) Python 체크
where python >nul 2>nul
if errorlevel 1 (
    echo [X] Python 이 설치되어 있지 않습니다. https://python.org
    pause
    exit /b 1
)
echo [OK] Python

REM 2) Node.js + npm 체크
where npm >nul 2>nul
if errorlevel 1 (
    echo [X] npm 이 설치되어 있지 않습니다. https://nodejs.org 에서 Node.js 설치 후 다시 실행하세요.
    pause
    exit /b 1
)
echo [OK] npm

REM 3) higgsfield CLI 체크 / 설치
where higgsfield >nul 2>nul
if errorlevel 1 (
    echo [..] higgsfield CLI 가 없습니다. 설치 중...
    call npm install -g @higgsfield/cli
    if errorlevel 1 (
        echo [X] @higgsfield/cli 설치 실패
        pause
        exit /b 1
    )
)
echo [OK] higgsfield CLI

REM 4) 로그인 확인
higgsfield auth token >nul 2>nul
if errorlevel 1 (
    echo [!] 아직 로그인하지 않았습니다.
    echo     아래 명령을 실행해 브라우저로 로그인하세요:
    echo       higgsfield auth login
    echo.
)

REM 5) .env 파일 생성
if not exist ".env" (
    if exist ".env.example" (
        copy /Y ".env.example" ".env" >nul
        echo [OK] .env 파일 생성됨
    )
) else (
    echo [OK] .env 파일 이미 존재
)

echo.
echo === 다음 단계 ===
echo 1) 로그인 안 했으면: higgsfield auth login
echo 2) .env 의 CCDATA_DIR 을 PV 와 동일하게 설정 (옵션)
echo 3) start.bat 더블클릭으로 서버 시작
echo 4) 브라우저에서 http://127.0.0.1:8767 접속
echo.
pause
