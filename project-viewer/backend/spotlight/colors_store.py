"""카드 컬러 마커 — 프로젝트별 <project>/_meta/colors.json.

R/G/B 키로 카드에 빨강/초록/파랑 마커를 붙이는 기능. 색별 필터/정렬 가능.

데이터 모델 (한 파일):
{
  "Result/hf_abc.png": "red",
  "Result/hf_def.mp4": "blue",
  ...
}

값은 "red" | "green" | "blue" 중 하나. 색이 없으면 entry 없음.
경로는 forward slash 정규화. 파일이 삭제되면 entry 도 자동 정리 안 함 (잔재 무해).
"""

import json
import os
from pathlib import Path
from threading import Lock

from ._paths import PROJECTS_DIR

META_SUBDIR = "_meta"
COLORS_FILENAME = "colors.json"
VALID_COLORS = {"red", "green", "blue"}

_LOCK = Lock()


def _colors_file(project: str) -> Path:
    return PROJECTS_DIR / project / META_SUBDIR / COLORS_FILENAME


def load_colors(project: str) -> dict:
    """{path: color} 반환. 없거나 깨졌으면 {}."""
    if not project:
        return {}
    p = _colors_file(project)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            # 유효한 색만 keep (validation)
            return {k: v for k, v in data.items() if v in VALID_COLORS}
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def _write_atomic(project: str, colors: dict) -> None:
    p = _colors_file(project)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(colors, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def set_colors_bulk(project: str, paths: list[str], color: str | None) -> dict:
    """다중 경로 일괄 변경. color=None 또는 빈 문자열이면 entry 제거. 반환: 갱신 dict."""
    if color and color not in VALID_COLORS:
        raise ValueError(f"invalid color: {color}")
    if not project:
        return {}
    with _LOCK:
        colors = load_colors(project)
        for raw in paths:
            if not raw:
                continue
            rel = raw.replace("\\", "/")
            if color:
                colors[rel] = color
            else:
                colors.pop(rel, None)
        _write_atomic(project, colors)
        return colors


def remove_path(project: str, rel_path: str) -> None:
    """파일이 삭제됐을 때 colors entry 도 정리. 폴더면 prefix 매치."""
    if not project or not rel_path:
        return
    rel = rel_path.replace("\\", "/")
    with _LOCK:
        colors = load_colors(project)
        before = len(colors)
        # 정확 매치 + prefix (폴더 통째 삭제)
        for key in list(colors.keys()):
            if key == rel or key.startswith(rel + "/"):
                colors.pop(key)
        if len(colors) != before:
            _write_atomic(project, colors)


def rename_path(project: str, old_rel: str, new_rel: str, *, is_dir: bool) -> None:
    """파일/폴더 rename 또는 move 시 colors key 도 따라가게."""
    if not project or not old_rel or not new_rel:
        return
    old = old_rel.replace("\\", "/")
    new = new_rel.replace("\\", "/")
    with _LOCK:
        colors = load_colors(project)
        changed = False
        for key in list(colors.keys()):
            if is_dir:
                if key == old or key.startswith(old + "/"):
                    new_key = new + key[len(old):]
                    colors[new_key] = colors.pop(key)
                    changed = True
            else:
                if key == old:
                    colors[new] = colors.pop(key)
                    changed = True
        if changed:
            _write_atomic(project, colors)


def all_colors_files() -> list[Path]:
    """SSE watcher 용 — 모든 프로젝트의 colors.json 경로."""
    out: list[Path] = []
    try:
        for proj in PROJECTS_DIR.iterdir():
            if not proj.is_dir() or proj.name.startswith("."):
                continue
            out.append(proj / META_SUBDIR / COLORS_FILENAME)
    except OSError:
        pass
    return out
