"""higgsfield CLI subprocess 호출 헬퍼."""

import json
import shutil
import subprocess

HF_CLI = shutil.which("higgsfield") or "higgsfield"


def run_cli(*args: str, timeout: int = 120) -> dict:
    """`higgsfield <args> --json` 을 실행해 결과를 dict 로 반환.
    실패 시 {"error": ...} 형식의 dict 반환.
    auth login 같이 JSON 출력하지 않는 명령은 {"ok": True/False, "output": ...} 반환."""
    cmd = [HF_CLI] + list(args) + ["--json"]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        stdout = result.stdout.strip()
        stderr = result.stderr.strip()

        # stdout JSON 파싱 시도
        if stdout:
            try:
                return json.loads(stdout)
            except (json.JSONDecodeError, ValueError):
                # JSON 아님 (예: auth login 의 평문 출력)
                if result.returncode == 0:
                    return {"ok": True, "output": stdout}
                return {"error": stdout}

        # stdout 비어있고 exit code 정상이면 단순 성공으로 처리
        if result.returncode == 0:
            return {"ok": True, "output": ""}

        # exit code 실패: stderr 에 메시지 있을 수 있음
        if stderr:
            try:
                return json.loads(stderr)
            except (json.JSONDecodeError, ValueError):
                return {"error": stderr}
        return {"error": f"exit code {result.returncode}"}
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
