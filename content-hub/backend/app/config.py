"""앱 설정·경로 (Phase 2).

로컬 우선 원칙(CLAUDE.md §1): 모든 경로는 backend/ 기준 로컬 디렉터리.
"""

from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent

# 결과물·썸네일·레퍼런스 원본을 받아둘 로컬 캐시(향후 byte-caching 용).
# 현재는 동기화한 원격 result_url 을 그대로 file_path 로 보관하고,
# 로컬로 받아둔 파일만 이 디렉터리에 저장한다.
MEDIA_DIR = Path(os.environ.get("CONTENT_HUB_MEDIA", BACKEND_DIR / "media")).resolve()

# 기본 작업자(개인 워크스테이션의 "나"). DESIGN.md §2 worker.
DEFAULT_WORKER_ID = os.environ.get("CONTENT_HUB_WORKER_ID", "me")
DEFAULT_WORKER_NAME = os.environ.get("CONTENT_HUB_WORKER_NAME", "나")

# 개발용 CORS 허용 오리진(Vite 기본 5173).
CORS_ORIGINS = os.environ.get(
    "CONTENT_HUB_CORS",
    "http://localhost:5173,http://127.0.0.1:5173",
).split(",")


def ensure_dirs() -> None:
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
