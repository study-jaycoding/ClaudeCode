"""push 적재(ingest) 라우터 — 각자 로컬 CLI 결과물을 서버로 모으는 입구.

설계(합의):
  · 서버는 힉스필드 CLI 를 돌리지 않는다. 각 팀원이 자기 PC·자기 CLI 로 생성하고
    `push_agent` 가 로컬 `generate list --json` 원본을 이 엔드포인트로 밀어올린다.
  · 인증은 '허브 로그인 세션'(미들웨어가 채운 request.state.account)으로만 — 힉스필드
    토큰은 서버로 오지 않는다.
  · 보낸 잡은 그 계정의 힉스필드 생성자 uid 로 귀속되고(결과 URL의 user_<id>),
    계정 ↔ 그 uid 가 연결돼 '내 작업' 분리가 성립한다. 미디어는 공개 URL 그대로.
"""

from __future__ import annotations

from collections import Counter

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response

from .. import repo
from ..config import BACKEND_DIR, DEFAULT_WORKER_ID
from ..models import IngestIn, IngestMcpIn, IngestOut
from ..services import cli_bridge
from ..services.agent_signals import agent_signals
from ..services.mcp_ingest import mcp_item_to_cli

# push_agent.py — 저장소 최상단(content-hub-server/). 팀원이 허브에서 받아 자기 PC에서 실행.
_AGENT_PATH = BACKEND_DIR.parent / "push_agent.py"

router = APIRouter(prefix="/api", tags=["ingest"])


def _acc(request: Request) -> dict:
    acc = getattr(request.state, "account", None)
    if not acc:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다(적재는 인증 필수)")
    return acc


def _ingest_core(acc, jobs, creator_uid, account_status) -> IngestOut:
    """CLI list 형태 잡들을 적재 + 계정↔힉스필드 uid 연결 + 크레딧 보고. push/mcp 공통 코어.
    각 잡은 자기 고유 creator_uid(URL의 user_<id>)를 유지하고, 이미 실제 uid 에 연결된 계정은
    재연결하지 않는다(레퍼런스 오염 방지, 실측 버그)."""
    # 신원 검증 — 에이전트가 보고한 로컬 CLI 계정(account status 의 email)이 허브 로그인 계정과
    # 같아야 그 계정 작업으로 확정한다. 다르면 남의 힉스필드 신원을 내 계정에 잘못 귀속시키는
    # 것이라 거부(self-report 무조건 신뢰 → 이메일 일치 '검증'으로 격상). 옛 에이전트는 email 을
    # 안 줄 수 있어 그땐 검사 생략(하위호환).
    reported_email = ((account_status or {}).get("email") or "").strip().lower()
    if reported_email and reported_email != (acc.get("email") or "").strip().lower():
        raise HTTPException(
            status_code=409,
            detail=(
                f"로컬 CLI 계정({reported_email})이 허브 로그인({acc.get('email')})과 다릅니다. "
                "같은 계정으로 로그인해야 내 작업으로 정확히 귀속됩니다."
            ),
        )
    cur_uid = acc.get("creator_uid")
    linked_real = bool(cur_uid) and not str(cur_uid).startswith("acct:")
    own_uid = creator_uid or (cur_uid if linked_real else None)

    counts = {"inserted": 0, "updated": 0, "unchanged": 0}
    skipped = 0
    uid_votes: Counter[str] = Counter()
    for raw in jobs:
        if not isinstance(raw, dict):
            skipped += 1
            continue
        parsed = cli_bridge.parse_job(raw)
        g = parsed.get("generation") or {}
        if not g.get("id"):
            skipped += 1
            continue
        if not g.get("creator_uid") and own_uid:  # uid 없을 때만 내 uid 로 보강(남의 건 보존)
            g["creator_uid"] = own_uid
        if g.get("creator_uid"):
            uid_votes[g["creator_uid"]] += 1
        result = repo.upsert_synced_generation(parsed, DEFAULT_WORKER_ID)
        counts[result] = counts.get(result, 0) + 1

    if linked_real:
        linked = cur_uid
    else:
        linked = creator_uid or (uid_votes.most_common(1)[0][0] if uid_votes else None)
        if linked:
            repo.set_account_hf_creator(acc["email"], linked)
    if account_status:
        repo.record_account_status(acc["email"], account_status)

    return IngestOut(
        inserted=counts["inserted"],
        updated=counts["updated"],
        unchanged=counts["unchanged"],
        skipped=skipped,
        linked_uid=linked,
    )


@router.post("/ingest", response_model=IngestOut)
def ingest(body: IngestIn, request: Request):
    """로컬 `generate list` 원본 묶음(최신분)을 적재 — push_agent 가 호출."""
    return _ingest_core(_acc(request), body.jobs, body.creator_uid, body.account_status)


@router.post("/ingest/mcp", response_model=IngestOut)
def ingest_mcp(body: IngestMcpIn, request: Request):
    """과거 전체 백필 — MCP `show_generations` 원시 아이템(100개 밖)을 적재. 멱등.
    흐름: Claude 가 그 사용자 세션으로 show_generations 를 next_cursor 끝까지 순회하며 각 페이지를
    이 엔드포인트로 POST. mcp_item_to_cli 로 CLI 형태 변환 후 push 와 동일 코어로 처리."""
    jobs = [mcp_item_to_cli(it) for it in body.items if isinstance(it, dict)]
    return _ingest_core(_acc(request), jobs, None, body.account_status)


@router.get("/credits")
def team_credits(request: Request):
    """팀 크레딧 집계(전체 합계 + 구성원별) — 에이전트가 보고한 마지막 잔액 기준. 로그인 필수."""
    if not getattr(request.state, "account", None):
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    return repo.credit_summary()


@router.get("/agent/download")
def download_agent():
    """push_agent.py 다운로드 — 공개(미들웨어 _AUTH_PUBLIC_PREFIXES). run-agent.bat 이 인증 없이
    curl 로 받게 한다. 스크립트엔 비밀이 없다(실제 push 는 여전히 허브 로그인 필요)."""
    if not _AGENT_PATH.is_file():
        raise HTTPException(status_code=404, detail="push_agent.py 를 찾을 수 없습니다")
    return FileResponse(
        _AGENT_PATH, filename="push_agent.py", media_type="text/x-python"
    )


@router.get("/agent/run-bat")
def run_agent_bat(request: Request):
    """원클릭 실행용 run-agent.bat — 서버 주소·로그인 이메일을 채워 반환. 더블클릭하면
    push_agent.py 를 자동으로 받아(curl) 상시(--watch) 실행한다. 로그인 필수(이메일 필요)."""
    acc = _acc(request)
    server = str(request.base_url).rstrip("/")
    email = acc["email"]
    bat = (
        "@echo off\r\n"
        "chcp 65001 >nul\r\n"
        'cd /d "%~dp0"\r\n'
        "rem 항상 최신 push_agent.py 를 받는다(임시파일 받아 성공 시 교체) — 코드 갱신 자동 반영.\r\n"
        "echo push_agent.py 최신본 받는 중...\r\n"
        f'curl -fsSL -o "%~dp0push_agent.py.new" "{server}/api/agent/download" 2>nul || '
        f"powershell -NoProfile -Command \"Invoke-WebRequest -Uri '{server}/api/agent/download' -OutFile 'push_agent.py.new'\" 2>nul\r\n"
        'if exist "%~dp0push_agent.py.new" move /y "%~dp0push_agent.py.new" "%~dp0push_agent.py" >nul\r\n'
        'if not exist "%~dp0push_agent.py" (echo [오류] push_agent.py 다운로드 실패 - 서버 주소를 확인하세요. & pause & exit /b 1)\r\n'
        'set "PY=python"\r\n'
        "where python >nul 2>nul || set \"PY=py\"\r\n"
        "where %PY% >nul 2>nul || (echo [오류] Python 미설치 - python.org 에서 설치 후 다시 실행하세요. & pause & exit /b 1)\r\n"
        f"%PY% push_agent.py --server {server} --email {email} --watch 30\r\n"
        "pause\r\n"
    )
    return Response(
        content=bat.encode("utf-8"),
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="run-agent.bat"'},
    )


@router.get("/agent/wait")
async def agent_wait(request: Request):
    """에이전트 롱폴 — 내 계정에 이벤트(생성요청/동기화)가 생길 때까지 대기하다 즉시 반환.
    타임아웃이면 wake=false(에이전트가 즉시 재대기). 30초 고정 폴링을 대체한다."""
    acc = _acc(request)
    reason = await agent_signals.wait(acc["email"], timeout=25.0)
    return {"wake": reason is not None, "reason": reason}


@router.post("/agent/sync")
def agent_sync(request: Request):
    """'내 작업 올리기' 버튼 — 내 에이전트를 깨워 로컬 결과물을 push 하게 한다."""
    acc = _acc(request)
    agent_signals.signal(acc["email"], "sync")
    return {"ok": True, "connected": agent_signals.connected(acc["email"])}


@router.get("/agent/status")
def agent_status(request: Request):
    """내 에이전트가 지금 붙어 있나(롱폴 대기 중) — UI 연결 점 표시용."""
    acc = _acc(request)
    return {"connected": agent_signals.connected(acc["email"])}


@router.get("/account/hf")
def my_hf_status(request: Request):
    """로그인 계정 본인이 에이전트로 보고한 힉스필드 상태(크레딧·플랜·워크스페이스) — 계정 메뉴가
    '내 것'을 표시할 때 쓴다. 브라우저는 그 계정 CLI에 직접 접근 못 하므로 이 보고값이 유일한 출처.
    보고 이력 없으면 reported=false(에이전트 미연결 안내)."""
    acc = _acc(request)
    st = repo.get_reported_status(acc["email"])
    if not st:
        return {"reported": False, "credits": None, "plan": None, "workspaces": []}
    return {
        "reported": True,
        "credits": st.get("credits"),
        "plan": st.get("plan"),
        "connected": st.get("connected"),
        "workspaces": st.get("workspaces") or [],
    }


@router.get("/ingest/known-jobs")
def known_jobs(request: Request):
    """이 계정(힉스필드 uid)으로 이미 서버에 있는 job_id 목록 — 에이전트가 새 것만 보내게.
    인증 필수. account.creator_uid 기준."""
    acc = getattr(request.state, "account", None)
    if not acc:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    uid = acc.get("creator_uid")
    return {"creator_uid": uid, "job_ids": repo.known_job_ids(uid) if uid else []}
