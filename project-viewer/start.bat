@echo off
REM 프로젝트 뷰어 + Higgsfield Spotlight 통합 서버
REM 더블클릭하면 backend/server.py 가 기동된다 (포트 8766).
cd /d "%~dp0backend"
python server.py
pause
