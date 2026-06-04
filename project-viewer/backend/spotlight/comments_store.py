"""파일별 코멘트 — 프로젝트별 <project>/_meta/comments.json.

팀 협업용 — 누구나 코멘트 남기고 누구나 읽을 수 있음. author 는 클라이언트가 보내는 값을
그대로 신뢰 (login 시스템 없음 — localStorage 의 viewer.commentAuthor).

데이터 모델:
{
  "Result/hf_abc.png": [
    {
      "id": "<hex token>",
      "author": "<user name>",
      "createdAt": <epoch ms>,
      "text": "<comment body>"
    },
    ...
  ],
  ...
}

경로는 forward slash 정규화. delete/rename/move 시 _sync_comments_path 로 따라감.
"""

import json
import os
import secrets
import time
from pathlib import Path
from threading import Lock

from ._paths import PROJECTS_DIR

META_SUBDIR = "_meta"
COMMENTS_FILENAME = "comments.json"

MAX_TEXT_LEN = 2000
MAX_AUTHOR_LEN = 80

_LOCK = Lock()


def _comments_file(project: str) -> Path:
    return PROJECTS_DIR / project / META_SUBDIR / COMMENTS_FILENAME


def load_all(project: str) -> dict:
    """{path: [comment, ...]} 반환. 없거나 깨졌으면 {}."""
    if not project:
        return {}
    p = _comments_file(project)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def _write_atomic(project: str, data: dict) -> None:
    p = _comments_file(project)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def add(project: str, rel_path: str, author: str, text: str) -> dict | None:
    """최상위 코멘트 추가. 성공 시 entry, 실패 (빈 텍스트 등) 시 None."""
    if not project or not rel_path:
        return None
    text = (text or "").strip()
    if not text:
        return None
    rel = rel_path.replace("\\", "/")
    entry = {
        "id": secrets.token_hex(8),
        "author": (author or "익명").strip()[:MAX_AUTHOR_LEN] or "익명",
        "createdAt": int(time.time() * 1000),
        "text": text[:MAX_TEXT_LEN],
        "replies": [],
    }
    with _LOCK:
        data = load_all(project)
        data.setdefault(rel, []).append(entry)
        _write_atomic(project, data)
    return entry


def add_reply(project: str, rel_path: str, parent_id: str, author: str, text: str) -> dict | None:
    """기존 코멘트에 답글 추가. parent_id 가 존재하지 않으면 None."""
    if not project or not rel_path or not parent_id:
        return None
    text = (text or "").strip()
    if not text:
        return None
    rel = rel_path.replace("\\", "/")
    reply = {
        "id": secrets.token_hex(8),
        "author": (author or "익명").strip()[:MAX_AUTHOR_LEN] or "익명",
        "createdAt": int(time.time() * 1000),
        "text": text[:MAX_TEXT_LEN],
    }
    with _LOCK:
        data = load_all(project)
        arr = data.get(rel) or []
        for c in arr:
            if c.get("id") == parent_id:
                if not isinstance(c.get("replies"), list):
                    c["replies"] = []
                c["replies"].append(reply)
                _write_atomic(project, data)
                return reply
    return None


def update(project: str, rel_path: str, comment_id: str, text: str) -> bool:
    """본문만 수정. 최상위/답글 둘 다 지원. 빈 텍스트는 무효."""
    if not project or not rel_path or not comment_id:
        return False
    text = (text or "").strip()
    if not text:
        return False
    rel = rel_path.replace("\\", "/")
    now = int(time.time() * 1000)
    with _LOCK:
        data = load_all(project)
        arr = data.get(rel) or []
        for c in arr:
            if c.get("id") == comment_id:
                c["text"] = text[:MAX_TEXT_LEN]
                c["editedAt"] = now
                _write_atomic(project, data)
                return True
            for r in (c.get("replies") or []):
                if r.get("id") == comment_id:
                    r["text"] = text[:MAX_TEXT_LEN]
                    r["editedAt"] = now
                    _write_atomic(project, data)
                    return True
    return False


def delete(project: str, rel_path: str, comment_id: str) -> bool:
    """단일 코멘트 또는 답글 제거. id 가 최상위면 thread 전체 제거,
    답글 id 면 그 답글만 제거. 마지막 최상위 코멘트면 path entry 자체 제거."""
    if not project or not rel_path or not comment_id:
        return False
    rel = rel_path.replace("\\", "/")
    with _LOCK:
        data = load_all(project)
        arr = data.get(rel)
        if not arr:
            return False
        # 최상위 매치
        new_arr = [c for c in arr if c.get("id") != comment_id]
        if len(new_arr) != len(arr):
            if new_arr:
                data[rel] = new_arr
            else:
                data.pop(rel, None)
            _write_atomic(project, data)
            return True
        # 답글 매치
        changed = False
        for c in arr:
            replies = c.get("replies")
            if not isinstance(replies, list):
                continue
            new_replies = [r for r in replies if r.get("id") != comment_id]
            if len(new_replies) != len(replies):
                c["replies"] = new_replies
                changed = True
                break
        if changed:
            _write_atomic(project, data)
            return True
        return False


def remove_path(project: str, rel_path: str) -> None:
    """파일/폴더가 삭제됐을 때 comments entry 도 정리. 폴더면 prefix 매치."""
    if not project or not rel_path:
        return
    rel = rel_path.replace("\\", "/")
    with _LOCK:
        data = load_all(project)
        before = len(data)
        for key in list(data.keys()):
            if key == rel or key.startswith(rel + "/"):
                data.pop(key)
        if len(data) != before:
            _write_atomic(project, data)


def rename_path(project: str, old_rel: str, new_rel: str, *, is_dir: bool) -> None:
    """파일/폴더 rename 또는 move 시 comments key 도 따라감."""
    if not project or not old_rel or not new_rel:
        return
    old = old_rel.replace("\\", "/")
    new = new_rel.replace("\\", "/")
    with _LOCK:
        data = load_all(project)
        changed = False
        for key in list(data.keys()):
            if is_dir:
                if key == old or key.startswith(old + "/"):
                    new_key = new + key[len(old):]
                    data[new_key] = data.pop(key)
                    changed = True
            else:
                if key == old:
                    data[new] = data.pop(key)
                    changed = True
        if changed:
            _write_atomic(project, data)


def all_comments_files() -> list[Path]:
    """SSE watcher 용."""
    out: list[Path] = []
    try:
        for proj in PROJECTS_DIR.iterdir():
            if not proj.is_dir() or proj.name.startswith("."):
                continue
            out.append(proj / META_SUBDIR / COMMENTS_FILENAME)
    except OSError:
        pass
    return out
