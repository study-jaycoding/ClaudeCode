"""higgsfield CLI subprocess 호출 헬퍼."""

import json
import subprocess

from config import HF_CLI


def run_cli(*args: str, timeout: int = 120) -> dict:
    """`higgsfield <args> --json` 을 실행해 결과를 dict 로 반환.
    실패 시 {"error": ...} 형식의 dict 반환."""
    cmd = [HF_CLI] + list(args) + ["--json"]
    print(f"[spotlight] CLI: {cmd}", flush=True)
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.stdout.strip():
            return json.loads(result.stdout)
        if result.returncode != 0:
            stderr = result.stderr.strip()
            try:
                return json.loads(stderr)
            except (json.JSONDecodeError, ValueError):
                return {"error": stderr or f"exit code {result.returncode}"}
        return {"error": "no output"}
    except subprocess.TimeoutExpired:
        return {"error": "timeout"}
    except FileNotFoundError:
        return {"error": "higgsfield CLI not found. Run: npm install -g @higgsfield/cli"}
    except Exception as e:
        return {"error": str(e)}


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
