"""미디어 로컬 캐시 — 출처 영속화 (provenance hardening).

설계 근거: project_content_hub_provenance — 소스·결과물이 원격 URL(Higgsfield
cloudfront, 계정 귀속·만료 가능)에만 있으면 나중에 재사용이 깨진다. 바이트를
로컬 MEDIA_DIR 로 내려받아 보관하고, 원본 URL 은 별도 컬럼(source_url)에 보존한다.

- 콘텐츠 주소화: URL 의 sha1 으로 파일명을 만들어 중복 다운로드를 피한다(dedupe).
- 비차단: 다운로드는 asyncio.to_thread 로 수행, 호출부에서 동시성 제한(gather).
- 실패 시 None 반환 → 호출부는 원격 URL 을 그대로 유지(출처는 source_url 로 보존).
"""

from __future__ import annotations

import asyncio
import hashlib
import urllib.request
from pathlib import Path
from typing import Optional

from ..config import MEDIA_DIR

_TIMEOUT = 30
_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm")


def _ext_of(url: str) -> str:
    path = url.split("?", 1)[0]
    for e in _EXTS:
        if path.lower().endswith(e):
            return e
    return ".bin"


def local_rel_for(url: str) -> str:
    """URL 에 대응하는 로컬 상대 경로(/media/<sha>.<ext>). 다운로드 여부와 무관."""
    sha = hashlib.sha1(url.encode("utf-8")).hexdigest()[:20]
    return f"/media/{sha}{_ext_of(url)}"


def _local_path(rel: str) -> Path:
    return MEDIA_DIR / rel.removeprefix("/media/")


def is_cached(url: str) -> bool:
    return _local_path(local_rel_for(url)).exists()


def _download(url: str, target: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "content-hub/0.1"})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        data = resp.read()
    tmp = target.with_suffix(target.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(target)  # 원자적 교체(부분 파일 방지)


async def cache_url(url: Optional[str]) -> Optional[str]:
    """원격 URL 을 로컬로 내려받고 /media 상대경로 반환. 이미 로컬이거나 실패 시 처리.

    - url 이 비었거나 이미 /media/.. 면 그대로(또는 None).
    - http(s) 가 아니면 캐시 대상 아님 → None.
    - 성공: /media/<sha>.<ext> 반환. 실패: None.
    """
    if not url:
        return None
    if url.startswith("/media/"):
        return url
    if not url.startswith(("http://", "https://")):
        return None

    rel = local_rel_for(url)
    target = _local_path(rel)
    if target.exists():
        return rel
    try:
        MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(_download, url, target)
        return rel
    except Exception:
        return None
