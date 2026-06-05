"""higgsfield CLI subprocess 호출 헬퍼."""

import json
import shutil
import subprocess
import sys

HF_CLI = shutil.which("higgsfield") or "higgsfield"

# 진단용 — 모든 CLI 호출의 cmd / returncode / stdout/stderr 요약을 stderr 로 dump.
# silent 실패 ("CLI 가 job_id 를 만들지 않음") 시 원인 추적의 결정적 증거.
def _log_cli(cmd: list, result, parsed: object) -> None:
    try:
        joined = " ".join(cmd)
        rc = getattr(result, "returncode", "?")
        so = (getattr(result, "stdout", "") or "")[:400].replace("\n", "\\n")
        se = (getattr(result, "stderr", "") or "")[:400].replace("\n", "\\n")
        p_short = str(parsed)[:200]
        print(f"[hf-cli] {joined}  rc={rc}  stdout={so!r}  stderr={se!r}  parsed={p_short}", file=sys.stderr)
    except Exception:
        pass


def run_cli(*args: str, timeout: int = 120) -> dict:
    """`higgsfield <args> --json` 을 실행해 결과를 dict 로 반환.
    실패 시 {"error": ..., "_raw": ...} 형식의 dict 반환 (raw 는 진단용).
    auth login 같이 JSON 출력하지 않는 명령은 {"ok": True/False, "output": ...} 반환.

    모든 호출은 stderr 로 진단 로그를 남긴다 (silent fail 추적용).
    """
    cmd = [HF_CLI] + list(args) + ["--json"]
    result = None
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
        )
        stdout = (result.stdout or "").strip()
        stderr = (result.stderr or "").strip()

        # stdout JSON 파싱 시도
        if stdout:
            try:
                parsed = json.loads(stdout)
                _log_cli(cmd, result, parsed)
                return parsed
            except (json.JSONDecodeError, ValueError):
                # JSON 아님 (예: auth login 의 평문 출력)
                if result.returncode == 0:
                    out = {"ok": True, "output": stdout}
                    _log_cli(cmd, result, out)
                    return out
                err = {"error": stdout, "_raw_stderr": stderr, "_rc": result.returncode}
                _log_cli(cmd, result, err)
                return err

        # stdout 비어있음.
        if result.returncode == 0:
            # silent success — 진짜 OK 일 수도, CLI 의 silent fail 일 수도.
            # 호출자가 jid 같은 결과 기대했는데 비어있으면 stderr/raw 가 진단 핵심.
            out = {"ok": True, "output": "", "_raw_stderr": stderr, "_rc": 0}
            _log_cli(cmd, result, out)
            return out

        # exit code 실패: stderr 에 메시지 있을 수 있음
        if stderr:
            try:
                parsed = json.loads(stderr)
                _log_cli(cmd, result, parsed)
                return parsed
            except (json.JSONDecodeError, ValueError):
                err = {"error": stderr, "_rc": result.returncode}
                _log_cli(cmd, result, err)
                return err
        err = {"error": f"exit code {result.returncode}", "_rc": result.returncode}
        _log_cli(cmd, result, err)
        return err
    except subprocess.TimeoutExpired:
        err = {"error": f"timeout after {timeout}s", "_timeout": True}
        print(f"[hf-cli] {' '.join(cmd)}  TIMEOUT after {timeout}s", file=sys.stderr)
        return err
    except FileNotFoundError:
        err = {"error": "higgsfield CLI not found. Run: npm install -g @higgsfield/cli"}
        print(f"[hf-cli] CLI not found: {HF_CLI}", file=sys.stderr)
        return err
    except Exception as e:
        err = {"error": str(e)}
        print(f"[hf-cli] {' '.join(cmd)}  EXCEPTION: {e}", file=sys.stderr)
        return err


def is_logged_in() -> bool:
    """CLI 토큰 존재 여부 (빠른 확인용)."""
    try:
        result = subprocess.run(
            [HF_CLI, "auth", "token"],
            capture_output=True, text=True, timeout=10,
        )
        return result.returncode == 0 and result.stdout.strip().startswith("hf_")
    except Exception:
        return False
