@echo off
REM ============================================================================
REM  Content Hub - 서버 모드 단일 실행 스크립트
REM
REM  하는 일: 프론트엔드를 빌드(dist) 한 뒤, 백엔드가 그 dist 를 같은 오리진에서
REM           서빙하도록 0.0.0.0 으로 기동한다. 프론트의 상대경로(/api·/ws·/media)
REM           가 그대로 동작 → 실서버에 이 폴더째 올려도 무변경으로 작동한다.
REM
REM  접속: 같은 PC      http://127.0.0.1:%PORT%   (★ localhost 대신 127.0.0.1 권장)
REM        같은 네트워크 http://<이 PC의 IP>:%PORT%   (IP 는 ipconfig 로 확인)
REM
REM  ※ Windows 에서 'localhost' 는 IPv6(::1)를 먼저 시도하고 ~200ms 기다린 뒤 IPv4 로
REM    폴백한다(서버는 IPv4 0.0.0.0 바인딩). 이 연결 지연이 체감 '로딩 딜레이'의 정체이며,
REM    127.0.0.1 로 접속하면 사라진다. 같은 네트워크(IP 직접 접속) 팀원은 처음부터 영향 없음.
REM
REM  포트/바인딩 바꾸기: 아래 PORT/HOST 수정하거나, 환경변수
REM        CONTENT_HUB_PORT / CONTENT_HUB_HOST 로 재정의.
REM ============================================================================
setlocal
set "ROOT=%~dp0"
if "%HOST%"=="" set "HOST=0.0.0.0"
if "%PORT%"=="" set "PORT=8010"

REM ── 로그인 강제(다중 계정) ──────────────────────────────────────────────────
REM  1 = 로그인 필수(팀 서버: 각자 계정으로 접속). 0 = 로그인 없음(개인 PC·개발, 모두 "나").
REM  ★ 끄려면 아래를 0 으로. 외부에서 CONTENT_HUB_AUTH 를 미리 지정하면 그 값을 존중.
if "%CONTENT_HUB_AUTH%"=="" set "CONTENT_HUB_AUTH=1"

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
echo     같은 PC 접속: http://127.0.0.1:%PORT%   ^(localhost 는 느림 - IPv6 폴백 ~200ms^)
echo     ^(종료: Ctrl+C^)
cd /d "%ROOT%backend" || goto :err
set "CONTENT_HUB_HOST=%HOST%"
set "CONTENT_HUB_PORT=%PORT%"
if "%CONTENT_HUB_AUTH%"=="1" (echo     로그인: 필수 ^(각자 계정으로 접속^)) else (echo     로그인: 없음 ^(모두 "나" 신원 공유^))
REM serve.py = IPv4(0.0.0.0)+IPv6 루프백(::1) 듀얼 스택 기동 → localhost 접속의
REM IPv6 폴백 ~200ms 지연 제거. LAN(IPv4) 접속은 그대로. (--reload 금지: CLI subprocess 깨짐)
python serve.py
goto :eof

:err
echo.
echo [오류] 위 단계에서 실패 - 중단합니다.
exit /b 1
