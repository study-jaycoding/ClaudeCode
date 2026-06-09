"""higgsfield CLI 브리지 (Phase 3).

asyncio subprocess 로 `higgsfield` CLI 를 감싼다. 필드 매핑은 실제
`higgsfield generate list --json` / `model list --json` 출력으로 검증함
(DESIGN.md §5 Phase 3 전제조건).

Windows 함정(검증 완료):
- `higgsfield` 는 npm 셰임 `higgsfield.CMD` 다. PATH 이름이 아니라
  `shutil.which()` 로 해석한 절대경로로 실행해야 FileNotFoundError 가 안 난다.
- subprocess 는 Proactor 이벤트 루프가 필요하다. Python 3.14 의 Windows 기본
  루프가 이미 Proactor 이고 uvicorn 도 이를 사용하므로 별도 정책 설정은 안 한다.

검증된 list 항목 매핑:
    id            → higgsfield job id (generation.id 로 그대로 사용해 재동기 멱등)
    status        → completed|... → 로컬 status 로 정규화
    job_set_type  → generation.model
    display_name  → 모델 표시명
    result_url    → asset.file_path (확장자로 image/video 판별)
    created_at    → epoch(float) → ISO 문자열
    params.prompt → generation.prompt
    params.medias → [{data:{id,url}, role}] → reference 목록
"""

from __future__ import annotations

import asyncio
import json
import shutil
from datetime import datetime, timezone
from typing import Any, Optional

# ── CLI 경로 해석 (셰임 함정 회피) ────────────────────────────────────────
_CLI_PATH: Optional[str] = None


class CLIError(RuntimeError):
    """CLI 호출 실패(0이 아닌 종료코드 또는 미설치)."""


def cli_path() -> str:
    global _CLI_PATH
    if _CLI_PATH is None:
        found = shutil.which("higgsfield") or shutil.which("hf")
        if not found:
            raise CLIError("higgsfield CLI 를 찾을 수 없음 (PATH 확인)")
        _CLI_PATH = found
    return _CLI_PATH


def cli_available() -> bool:
    try:
        cli_path()
        return True
    except CLIError:
        return False


async def _run(*args: str, timeout: float = 60.0) -> str:
    """CLI 를 실행하고 stdout(텍스트)을 반환. 절대경로로 실행."""
    proc = await asyncio.create_subprocess_exec(
        cli_path(),
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as e:
        proc.kill()
        raise CLIError(f"CLI 타임아웃: higgsfield {' '.join(args)}") from e
    if proc.returncode != 0:
        msg = (err or b"").decode("utf-8", "replace").strip()
        raise CLIError(f"higgsfield {' '.join(args)} 실패(rc={proc.returncode}): {msg}")
    return (out or b"").decode("utf-8", "replace")


async def _run_json(*args: str, timeout: float = 60.0) -> Any:
    raw = await _run(*args, "--json", timeout=timeout)
    raw = raw.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise CLIError(f"JSON 파싱 실패: {raw[:200]}") from e


# ── 정규화 헬퍼 ──────────────────────────────────────────────────────────
_STATUS_MAP = {
    "completed": "done",
    "succeeded": "done",
    "success": "done",
    "done": "done",
    "failed": "failed",
    "error": "failed",
    "canceled": "failed",
    "cancelled": "failed",
    "queued": "pending",
    "in_queue": "pending",
    "pending": "pending",
    "created": "pending",
    "running": "running",
    "processing": "running",
    "in_progress": "running",
}

_VIDEO_EXT = (".mp4", ".mov", ".webm", ".mkv", ".avi")


def normalize_status(raw: Optional[str]) -> str:
    """CLI status → 로컬 status. 모르는 값은 그대로 통과(방어적)."""
    if not raw:
        return "pending"
    return _STATUS_MAP.get(raw.lower(), raw.lower())


def media_type_from_url(url: Optional[str]) -> str:
    if not url:
        return "image"
    low = url.lower().split("?", 1)[0]
    return "video" if low.endswith(_VIDEO_EXT) else "image"


def epoch_to_iso(value: Any) -> str:
    """epoch(float/int) → 'YYYY-MM-DD HH:MM:SS' (UTC). 실패 시 현재시각."""
    try:
        dt = datetime.fromtimestamp(float(value), tz=timezone.utc)
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError, OverflowError):
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def parse_job(job: dict[str, Any]) -> dict[str, Any]:
    """list/get 의 한 잡(dict) → 로컬 DB 업서트용 정규 구조.

    반환 구조:
        {
          generation: {id, prompt, model, params(json), status, created_at, display_name},
          asset: {type, file_path} | None,
          references: [{id, type, file_path, role}],
        }
    """
    params = job.get("params") or {}
    result_url = job.get("result_url")

    references: list[dict[str, Any]] = []
    for m in params.get("medias") or []:
        data = (m or {}).get("data") or {}
        url = data.get("url")
        if not url:
            continue
        references.append(
            {
                "id": data.get("id"),
                "type": media_type_from_url(url),
                "file_path": url,
                "role": m.get("role"),
            }
        )

    asset = None
    if result_url:
        asset = {"type": media_type_from_url(result_url), "file_path": result_url}

    return {
        "generation": {
            "id": job.get("id"),
            "prompt": params.get("prompt") or "(제목 없음)",
            "model": job.get("job_set_type"),
            "display_name": job.get("display_name"),
            "params": params,
            "status": normalize_status(job.get("status")),
            "created_at": epoch_to_iso(job.get("created_at")),
        },
        "asset": asset,
        "references": references,
    }


# ── 공개 API ─────────────────────────────────────────────────────────────
async def list_jobs(timeout: float = 60.0) -> list[dict[str, Any]]:
    """최근 생성 잡 목록(정규화된 구조)."""
    data = await _run_json("generate", "list", timeout=timeout)
    if not isinstance(data, list):
        return []
    return [parse_job(j) for j in data if isinstance(j, dict)]


async def get_job(job_id: str, timeout: float = 60.0) -> Optional[dict[str, Any]]:
    """단일 잡 조회(정규화된 구조)."""
    data = await _run_json("generate", "get", job_id, timeout=timeout)
    if isinstance(data, list):
        data = data[0] if data else None
    if not isinstance(data, dict):
        return None
    return parse_job(data)


async def list_models(timeout: float = 60.0) -> list[dict[str, Any]]:
    """생성 모달용 모델 목록 [{display_name, job_set_type, type}]."""
    data = await _run_json("model", "list", timeout=timeout)
    if not isinstance(data, list):
        return []
    out = []
    for m in data:
        if not isinstance(m, dict):
            continue
        out.append(
            {
                "display_name": m.get("display_name") or m.get("job_set_type") or "?",
                "job_set_type": m.get("job_set_type") or "",
                "type": m.get("type") or "image",
            }
        )
    return out


async def create_job(
    model: str,
    prompt: str,
    params: Optional[dict[str, Any]] = None,
    media: Optional[list[tuple[str, str]]] = None,
    timeout: float = 600.0,
) -> dict[str, Any]:
    """생성 잡을 만든다 (⚠️ 실제 크레딧이 소모되는 유료 호출).

    media: [(flag, value)] 예) [("--image", "/path.png"), ("--start-image", "<uuid>")].
    --wait 로 완료까지 블록하고 결과를 파싱해 반환한다.
    잡 큐(jobs.py)의 워커에서만 호출한다.
    """
    args: list[str] = ["generate", "create", model, "--prompt", prompt, "--wait"]
    for k, v in (params or {}).items():
        if v is None:
            continue
        args += [f"--{k}", str(v)]
    for flag, value in media or []:
        args += [flag, value]

    data = await _run_json(*args, timeout=timeout)
    # create --wait 출력은 잡 객체(또는 배열). 정규화해서 반환.
    if isinstance(data, list):
        data = data[0] if data else {}
    if not isinstance(data, dict):
        data = {}
    return parse_job(data)
