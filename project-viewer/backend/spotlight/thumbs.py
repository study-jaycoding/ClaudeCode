"""서버 사이드 썸네일 생성 + 디스크 캐시.

원본 이미지/비디오의 작은 JPG 썸네일을 _meta/_thumbs/ 에 저장. 한 번 만들면
영구. 같은 (project, path, size) 요청은 in-flight dedup → 50개 동시 spawn 회피.

의존성 (optional):
- Pillow : 이미지. 없으면 fallback (원본 그대로 응답).
- ffmpeg : 비디오. PATH 에 있어야. 없으면 fallback.
"""

import hashlib
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Callable, Optional

from spotlight._paths import PROJECTS_DIR

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

THUMB_DIR_NAME = "_thumbs"
DEFAULT_SIZE = 800              # 긴 변 max px (카드 320 + retina 2x 까지 커버)
MIN_SIZE, MAX_SIZE = 64, 2048
JPEG_QUALITY = 80
FFMPEG_TIMEOUT_SEC = 30

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}

# 동시 생성 cap — 50개 ffmpeg 한꺼번에 spawn 회피
_MAX_CONCURRENT = 4
_sem = threading.Semaphore(_MAX_CONCURRENT)

# in-flight dedup — 같은 (project, rel, size) 두 번째 호출은 첫 번째 완료까지 대기
_inflight: dict[str, threading.Event] = {}
_inflight_lock = threading.Lock()


def _cache_path(project: str, rel: str, size: int) -> Path:
    """sha1(rel) 기반 캐시 파일 경로. 같은 (rel, size) → 같은 파일."""
    h = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]
    return PROJECTS_DIR / project / "_meta" / THUMB_DIR_NAME / f"{h}_{size}.jpg"


def _ext(rel: str) -> str:
    return Path(rel).suffix.lower()


def _make_image_thumb(src: Path, dest: Path, size: int) -> bool:
    """Pillow 로 이미지 → JPEG 썸네일. 원자적 쓰기 (temp + os.replace)."""
    if not HAS_PIL:
        return False
    tmp: Optional[Path] = None
    try:
        with Image.open(src) as im:
            im.thumbnail((size, size), Image.LANCZOS)
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGB")
            fd, tmp_name = tempfile.mkstemp(dir=str(dest.parent), suffix=".jpg.tmp")
            os.close(fd)
            tmp = Path(tmp_name)
            im.save(tmp, "JPEG", quality=JPEG_QUALITY, optimize=True)
        os.replace(tmp, dest)
        tmp = None
        return True
    except Exception as e:
        print(f"[thumbs] image fail {src}: {e}", file=sys.stderr)
        return False
    finally:
        if tmp is not None:
            try: tmp.unlink()
            except Exception: pass


def _make_video_thumb(src: Path, dest: Path, size: int) -> bool:
    """ffmpeg 로 비디오 첫 프레임 추출 → 리사이즈된 JPEG. 원자적 쓰기."""
    tmp: Optional[Path] = None
    try:
        fd, tmp_name = tempfile.mkstemp(dir=str(dest.parent), suffix=".jpg.tmp")
        os.close(fd)
        tmp = Path(tmp_name)
        # -ss 0.5: 첫 0.5s 프레임 (0s 는 black 일 수 있음).
        # -vf scale: 긴 변 = size, 짧은 변 = 비율 유지 + 짝수.
        # -f image2: tmp 파일 확장자가 .jpg.tmp 라 ffmpeg 가 자동 추론 못함 → 명시.
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-ss", "0.5",
            "-i", str(src),
            "-vframes", "1",
            "-vf", f"scale='if(gt(iw,ih),{size},-2)':'if(gt(iw,ih),-2,{size})'",
            "-q:v", "5",
            "-f", "image2",
            str(tmp),
        ]
        result = subprocess.run(
            cmd, capture_output=True, timeout=FFMPEG_TIMEOUT_SEC, check=False,
        )
        if result.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
            return False
        os.replace(tmp, dest)
        tmp = None
        return True
    except Exception as e:
        print(f"[thumbs] video fail {src}: {e}", file=sys.stderr)
        return False
    finally:
        if tmp is not None:
            try: tmp.unlink()
            except Exception: pass


def ensure_thumb(
    project: str, rel: str, size: int = DEFAULT_SIZE,
    *, src_resolver: Callable[[str, str], Optional[Path]],
) -> Optional[Path]:
    """캐시 hit 면 즉시 path, miss 면 생성 후 path. 실패 시 None.

    src_resolver(project, rel) -> Path | None: server.py 의 safe_resolve 주입.
    이 함수는 src_resolver 가 반환한 경로의 안전성을 가정한다 (별도 검증 안 함).
    """
    src = src_resolver(project, rel)
    if src is None or not src.is_file():
        return None

    size = max(MIN_SIZE, min(MAX_SIZE, int(size)))
    cache = _cache_path(project, rel, size)
    if cache.is_file():
        # cache 가 원본보다 오래됐으면 stale — 같은 path 의 다른 파일이 새로 들어온
        # 케이스 (apiUpload 의 unique_path 가 옛 삭제 후 같은 이름 재사용 등).
        try:
            if src.stat().st_mtime <= cache.stat().st_mtime:
                return cache
            # stale — 아래 재생성으로 fallthrough.
            try: cache.unlink()
            except OSError: pass
        except OSError:
            return cache

    # in-flight dedup — 같은 key 가 동시에 두 번 요청되면 한 번만 생성
    key = f"{project}|{rel}|{size}"
    with _inflight_lock:
        existing = _inflight.get(key)
        if existing is None:
            our_event = threading.Event()
            _inflight[key] = our_event
        else:
            our_event = None

    if our_event is None:
        existing.wait(timeout=FFMPEG_TIMEOUT_SEC + 5)
        return cache if cache.is_file() else None

    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        with _sem:  # 동시 생성 cap
            ext = _ext(rel)
            if ext in IMAGE_EXTS:
                ok = _make_image_thumb(src, cache, size)
            elif ext in VIDEO_EXTS:
                ok = _make_video_thumb(src, cache, size)
            else:
                ok = False
        return cache if ok and cache.is_file() else None
    finally:
        with _inflight_lock:
            _inflight.pop(key, None)
        our_event.set()
