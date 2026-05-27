@echo off
REM 프로젝트 매니저 서버 실행 스크립트
REM 더블클릭하거나 명령 프롬프트에서 실행하면 backend/server.py 가 기동된다.
cd /d "%~dp0backend"
python server.py
pause
