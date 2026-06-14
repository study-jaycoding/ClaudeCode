@echo off
REM ============================================================================
REM  Content Hub - 서버 모드 단일 실행 스크립트
REM
REM  하는 일: 프론트엔드를 빌드(dist) 한 뒤, 백엔드가 그 dist 를 같은 오리진에서
REM           서빙하도록 0.0.0.0 으로 기동한다. 프론트의 상대경로(/api·/ws·/media)
REM           가 그대로 동작 → 실서버에 이 폴더째 올려도 무변경으로 작동한다.
REM
REM  접속: 같은 PC      http://localhost:%PORT%
REM        같은 네트워크 http://<이 PC의 IP>:%PORT%   (IP 는 ipconfig 로 확인)
REM
REM  포트/바인딩 바꾸기: 아래 PORT/HOST 수정하거나, 환경변수
REM        CONTENT_HUB_PORT / CONTENT_HUB_HOST 로 재정의.
REM ============================================================================
setlocal
set "ROOT=%~dp0"
if "%HOST%"=="" set "HOST=0.0.0.0"
if "%PORT%"=="" set "PORT=8000"

echo.
echo [1/3] 프론트엔드 의존성 확인...
cd /d "%ROOT%frontend" || goto :err
if not exist node_modules (
  echo     node_modules 없음 - npm install 실행 ^(최초 1회, 수 분^)
  call npm install || goto :err
)

echo [2/3] 프론트엔드 빌드 ^(dist^)...
call npm run build || goto :err

echo [3/3] 백엔드 기동  http://%HOST%:%PORT%
echo     ^(종료: Ctrl+C^)
cd /d "%ROOT%backend" || goto :err
set "CONTENT_HUB_HOST=%HOST%"
set "CONTENT_HUB_PORT=%PORT%"
REM uvicorn CLI = Windows 에서 검증된 실행 경로(--reload 금지: CLI subprocess 깨짐)
python -m uvicorn app.main:app --host %HOST% --port %PORT%
goto :eof

:err
echo.
echo [오류] 위 단계에서 실패 - 중단합니다.
exit /b 1
