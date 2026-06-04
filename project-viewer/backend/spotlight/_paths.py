"""공통 경로 상수 — spotlight 패키지 모든 모듈이 이 한 곳에서 읽는다.

server.py 의 _load_dotenv() 가 이 모듈 import 전에 호출되어야 환경변수 반영됨.
모듈 import 자체에 부작용 없음 (Path 객체만 만든다).
"""

import os
from pathlib import Path

CCDATA_DIR = Path(os.environ.get("CCDATA_DIR", "D:/ClaudeCode-data"))
PROJECTS_DIR = Path(os.environ.get("CCDATA_PROJECTS_DIR", str(CCDATA_DIR / "projects")))
