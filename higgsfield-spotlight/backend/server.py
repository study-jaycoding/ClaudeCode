"""
Higgsfield Spotlight -- image generation launcher backend.

Port: 8767
Auth: higgsfield CLI (npm @higgsfield/cli) — run 'higgsfield auth login' first
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import mimetypes
import os
import subprocess
import shutil
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, parse_qs

BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent
FRONTEND_DIR = ROOT_DIR / "frontend"
PORT = 8767

PROJECTS_DIR = Path("D:/ClaudeCode-data/projects")
FAVORITES_FILE = Path("D:/ClaudeCode-data/favorites.json")

HF_CLI = shutil.which("higgsfield") or "higgsfield"

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}

MODEL_CATALOG = [
    # ── Image ──
    {"id": "nano_banana_2", "name": "Nano Banana Pro", "provider": "Google", "type": "image",
     "description": "Ultimate quality, 4K",
     "aspect_ratios": ["1:1", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "9:16", "16:9", "21:9"],
     "options": {"resolution": {"values": ["1k", "2k", "4k"], "default": "2k"}}},
    {"id": "nano_banana_flash", "name": "Nano Banana 2", "provider": "Google", "type": "image",
     "description": "Fast, high-quality",
     "aspect_ratios": ["1:1", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "9:16", "16:9", "21:9"],
     "options": {"resolution": {"values": ["1k", "2k", "4k"], "default": "2k"}}},
    {"id": "nano_banana", "name": "Nano Banana", "provider": "Google", "type": "image",
     "description": "Budget-friendly",
     "aspect_ratios": ["1:1", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "9:16", "16:9", "21:9"],
     "options": {}},
    {"id": "seedream_v4_5", "name": "Seedream 4.5", "provider": "Bytedance", "type": "image",
     "description": "High quality, precise control",
     "aspect_ratios": ["1:1", "4:3", "16:9", "3:2", "21:9", "3:4", "9:16", "2:3"],
     "options": {"quality": {"values": ["basic", "high"], "default": "basic"}}},
    {"id": "seedream_v5_lite", "name": "Seedream 5.0 lite", "provider": "Bytedance", "type": "image",
     "description": "Visual reasoning, editing",
     "aspect_ratios": ["1:1", "16:9", "9:16", "4:3", "3:4"],
     "options": {"quality": {"values": ["basic", "high"], "default": "basic"}}},
    {"id": "flux_2", "name": "FLUX.2", "provider": "Black Forest Labs", "type": "image",
     "description": "Precise prompt adherence",
     "aspect_ratios": ["1:1", "4:3", "3:4", "16:9", "9:16"],
     "options": {"resolution": {"values": ["1k", "2k"], "default": "1k"},
                 "flux_variant": {"values": ["pro", "flex", "max"], "default": "pro"}}},
    {"id": "flux_kontext", "name": "Flux Kontext", "provider": "Black Forest Labs", "type": "image",
     "description": "Editing and style transfer",
     "aspect_ratios": ["1:1", "4:3", "3:4", "16:9", "9:16"],
     "options": {}},
    {"id": "gpt_image_2", "name": "GPT Image 2", "provider": "OpenAI", "type": "image",
     "description": "Text rendering, 4K",
     "aspect_ratios": ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
     "options": {"resolution": {"values": ["1k", "2k", "4k"], "default": "2k"},
                 "quality": {"values": ["low", "medium", "high"], "default": "high"},
                 "batch_size": {"min": 1, "max": 4, "default": 1}}},
    {"id": "grok_image", "name": "Grok Image", "provider": "xAI", "type": "image",
     "description": "High-contrast generation",
     "aspect_ratios": ["1:1", "4:3", "3:4", "16:9", "9:16"],
     "options": {"mode": {"values": ["std", "quality"], "default": "std"}}},
    {"id": "text2image_soul_v2", "name": "Soul V2", "provider": "Higgsfield", "type": "image",
     "description": "UGC, fashion, character",
     "aspect_ratios": ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
     "options": {"quality": {"values": ["1.5k", "2k"], "default": "2k"}}},
    {"id": "soul_cinematic", "name": "Soul Cinematic", "provider": "Higgsfield", "type": "image",
     "description": "Cinema-grade stills",
     "aspect_ratios": ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
     "options": {"quality": {"values": ["1.5k", "2k"], "default": "2k"}}},
    {"id": "kling_omni_image", "name": "Kling O1 Image", "provider": "Kling", "type": "image",
     "description": "Photorealistic generation",
     "aspect_ratios": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"],
     "options": {"resolution": {"values": ["1k", "2k"], "default": "1k"}}},
    {"id": "cinematic_studio_2_5", "name": "Cinema Studio 2.5", "provider": "Higgsfield", "type": "image",
     "description": "Cinematic stills, 4K",
     "aspect_ratios": ["1:1", "4:3", "3:4", "16:9", "9:16"],
     "options": {"resolution": {"values": ["1k", "2k", "4k"], "default": "1k"}}},
    {"id": "z_image", "name": "Z Image", "provider": "Tongyi-MAI", "type": "image",
     "description": "Super fast, stylized",
     "aspect_ratios": ["1:1", "4:3", "3:4", "16:9", "9:16"],
     "options": {}},
    {"id": "image_auto", "name": "Auto", "provider": "Higgsfield", "type": "image",
     "description": "Auto-selects model",
     "aspect_ratios": ["1:1", "4:3", "3:4", "16:9", "9:16"],
     "options": {}},
    # ── Video ──
    {"id": "seedance_2_0", "name": "Seedance 2.0", "provider": "Bytedance", "type": "video",
     "description": "Reference-driven, strong identity",
     "aspect_ratios": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
     "options": {"resolution": {"values": ["480p", "720p", "1080p"], "default": "720p"},
                 "mode": {"values": ["std", "fast"], "default": "std"},
                 "duration": {"min": 4, "max": 15, "default": 5},
                 "genre": {"values": ["auto", "action", "horror", "comedy", "noir", "drama", "epic"], "default": "auto"}}},
    {"id": "veo3_1", "name": "Veo 3.1", "provider": "Google", "type": "video",
     "description": "Latest Google video model",
     "aspect_ratios": ["16:9", "9:16"],
     "options": {"duration": {"min": 4, "max": 8, "default": 8},
                 "quality": {"values": ["basic", "high", "ultra"], "default": "basic"},
                 "veo_variant": {"values": ["veo-3-1-preview", "veo-3-1-fast"], "default": "veo-3-1-fast"}}},
    {"id": "veo3", "name": "Veo 3", "provider": "Google", "type": "video",
     "description": "High quality video generation",
     "aspect_ratios": ["16:9", "9:16"],
     "options": {"veo_variant": {"values": ["veo-3-preview", "veo-3-fast"], "default": "veo-3-fast"}}},
    {"id": "kling3_0", "name": "Kling v3.0", "provider": "Kling", "type": "video",
     "description": "Multi-shot, audio, motion transfer",
     "aspect_ratios": ["16:9", "9:16", "1:1"],
     "options": {"mode": {"values": ["std", "pro", "4k"], "default": "std"},
                 "duration": {"min": 5, "max": 15, "default": 5},
                 "sound": {"values": ["on", "off"], "default": "on"}}},
    {"id": "kling2_6", "name": "Kling 2.6", "provider": "Kling", "type": "video",
     "description": "Reliable video generation",
     "aspect_ratios": ["16:9", "9:16", "1:1"],
     "options": {"duration": {"min": 5, "max": 10, "default": 5}}},
    {"id": "minimax_hailuo", "name": "Minimax Hailuo", "provider": "Minimax", "type": "video",
     "description": "Fast video generation",
     "aspect_ratios": ["16:9", "9:16", "1:1"],
     "options": {"duration": {"min": 6, "max": 10, "default": 6},
                 "resolution": {"values": ["512", "768", "1080"], "default": "768"},
                 "minimax_variant": {"values": ["minimax", "minimax-fast", "minimax-2.3", "minimax-2.3-fast"], "default": "minimax-2.3"}}},
    {"id": "grok_video", "name": "Grok Video", "provider": "xAI", "type": "video",
     "description": "Expressive video generation",
     "aspect_ratios": ["16:9", "9:16", "1:1"],
     "options": {"duration": {"min": 5, "max": 15, "default": 5}}},
    {"id": "cinematic_studio_3_0", "name": "Cinema Studio 3.0", "provider": "Higgsfield", "type": "video",
     "description": "Cinematic video",
     "aspect_ratios": ["16:9", "9:16", "1:1"],
     "options": {"duration": {"min": 5, "max": 15, "default": 5}}},
    {"id": "cinematic_studio_video_v2", "name": "Cinema Studio V2", "provider": "Higgsfield", "type": "video",
     "description": "Genre-based cinematic video",
     "aspect_ratios": ["1:1", "4:3", "3:4", "16:9", "9:16"],
     "options": {"mode": {"values": ["std", "pro"], "default": "std"},
                 "duration": {"min": 5, "max": 12, "default": 5},
                 "genre": {"values": ["auto", "action", "horror", "comedy", "western", "suspense", "intimate", "spectacle"], "default": "auto"}}},
    {"id": "wan2_7", "name": "Wan 2.7", "provider": "Alibaba", "type": "video",
     "description": "Versatile video generation",
     "aspect_ratios": ["16:9", "9:16", "1:1", "4:3", "3:4"],
     "options": {"resolution": {"values": ["720p", "1080p"], "default": "720p"},
                 "duration": {"min": 5, "max": 15, "default": 5}}},
    {"id": "wan2_6", "name": "Wan 2.6", "provider": "Alibaba", "type": "video",
     "description": "Reliable video generation",
     "aspect_ratios": ["16:9", "9:16", "1:1"],
     "options": {"duration": {"min": 5, "max": 15, "default": 5},
                 "quality": {"values": ["720p", "1080p"], "default": "720p"}}},
    {"id": "seedance1_5", "name": "Seedance 1.5 Pro", "provider": "Bytedance", "type": "video",
     "description": "Stable video generation",
     "aspect_ratios": ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
     "options": {"resolution": {"values": ["480p", "720p", "1080p"], "default": "720p"},
                 "duration": {"min": 4, "max": 12, "default": 4}}},
]


def _resolve_local_path(local_url: str) -> Path | None:
    parsed = urlparse(local_url)
    params = parse_qs(parsed.query)
    project = params.get("project", [""])[0]
    rel = params.get("path", [""])[0]
    if not project or not rel or ".." in project or ".." in rel:
        return None
    filepath = (PROJECTS_DIR / project / rel).resolve()
    try:
        filepath.relative_to(PROJECTS_DIR.resolve())
    except ValueError:
        return None
    return filepath if filepath.is_file() else None


def _run_cli(*args: str, timeout: int = 120) -> dict:
    cmd = [HF_CLI] + list(args) + ["--json"]
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


ALLOWED_ORIGINS = {
    f"http://127.0.0.1:{PORT}",
    f"http://localhost:{PORT}",
}
ALLOWED_HOSTS = {
    f"127.0.0.1:{PORT}",
    f"localhost:{PORT}",
}


class Handler(BaseHTTPRequestHandler):

    def _check_same_origin(self) -> bool:
        """같은 origin (127.0.0.1:8767 또는 localhost:8767) 의 요청만 허용."""
        host = self.headers.get("Host", "")
        if host not in ALLOWED_HOSTS:
            return False
        site = self.headers.get("Sec-Fetch-Site")
        if site is not None and site != "same-origin":
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            return False
        return True

    def _send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(404, "Not Found")
            return
        mime = MIME_TYPES.get(path.suffix.lower(), "application/octet-stream")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/api/models":
            self._send_json(200, {"models": MODEL_CATALOG})
            return

        if path == "/api/balance":
            try:
                result = subprocess.run(
                    [HF_CLI, "auth", "token"],
                    capture_output=True, text=True, timeout=10,
                )
                has_token = result.returncode == 0 and result.stdout.strip().startswith("hf_")
            except Exception:
                has_token = False
            if has_token:
                self._send_json(200, {"credits": -1, "plan": "cli", "connected": True})
            else:
                self._send_json(200, {"credits": 0, "plan": "not_connected", "connected": False})
            return

        if path == "/api/favorites":
            if FAVORITES_FILE.exists():
                try:
                    favs = json.loads(FAVORITES_FILE.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    favs = []
            else:
                favs = []
            img_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
            image_favs = [
                f for f in favs
                if any(f.get("path", "").lower().endswith(e) for e in img_exts)
            ]
            self._send_json(200, {"favorites": image_favs})
            return

        if path == "/pv-media":
            project = params.get("project", [""])[0]
            rel = params.get("path", [""])[0]
            if not project or not rel:
                self.send_error(400, "Bad Request")
                return
            if ".." in project or ".." in rel:
                self.send_error(403, "Forbidden")
                return
            target = (PROJECTS_DIR / project / rel).resolve()
            try:
                target.relative_to(PROJECTS_DIR.resolve())
            except ValueError:
                self.send_error(403, "Forbidden")
                return
            if not target.is_file():
                self.send_error(404, "Not Found")
                return
            mime_type, _ = mimetypes.guess_type(str(target))
            if not mime_type:
                mime_type = "application/octet-stream"
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mime_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "max-age=3600")
            self.end_headers()
            self.wfile.write(data)
            return

        if path.startswith("/api/jobs/"):
            job_id = path[len("/api/jobs/"):]
            data = _run_cli("generate", "get", job_id)
            if "error" in data:
                self._send_json(502, data)
            else:
                status = data.get("status", "unknown")
                result_url = data.get("result_url", "")
                images = [{"url": result_url}] if result_url else []
                self._send_json(200, {"status": status, "images": images})
            return

        if path in ("/", ""):
            self._send_file(FRONTEND_DIR / "index.html")
            return

        candidate = (FRONTEND_DIR / path.lstrip("/")).resolve()
        try:
            candidate.relative_to(FRONTEND_DIR.resolve())
        except ValueError:
            self.send_error(403, "Forbidden")
            return
        self._send_file(candidate)

    def do_POST(self) -> None:
        if not self._check_same_origin():
            self._send_json(403, {"error": "허용되지 않은 요청입니다."})
            return

        parsed = urlparse(self.path)

        if parsed.path == "/api/upload":
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 20 * 1024 * 1024:
                self._send_json(400, {"error": "파일이 없거나 너무 큽니다 (최대 20MB)"})
                return
            filename = self.headers.get("X-File-Name", "upload.png")
            upload_dir = BACKEND_DIR / "_uploads"
            upload_dir.mkdir(exist_ok=True)
            import uuid
            safe_name = f"{uuid.uuid4().hex}_{filename}"
            target = upload_dir / safe_name
            raw = self.rfile.read(length)
            target.write_bytes(raw)
            self._send_json(200, {
                "path": str(target),
                "name": filename,
            })
            return

        if parsed.path == "/api/login":
            data = _run_cli("auth", "login", timeout=120)
            if "error" in data:
                err = data["error"]
                if isinstance(err, dict):
                    err = err.get("message", str(err))
                self._send_json(502, {"error": str(err)})
            else:
                self._send_json(200, {"ok": True})
            return

        if parsed.path == "/api/generate":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                self._send_json(400, {"error": "잘못된 JSON"})
                return

            model = payload.get("model", "")
            prompt = payload.get("prompt", "")
            if not model or not prompt:
                self._send_json(400, {"error": "model 과 prompt 는 필수입니다."})
                return

            args = ["generate", "create", model, "--prompt", prompt, "--wait"]

            aspect_ratio = payload.get("aspect_ratio")
            if aspect_ratio:
                args += ["--aspect_ratio", aspect_ratio]

            passthrough = {
                "resolution", "quality", "mode", "batch_size",
                "duration", "sound", "genre",
            }
            for key in passthrough:
                val = payload.get(key)
                if val is not None:
                    args += [f"--{key}", str(val)]

            for alias, flag in [("flux_variant", "model"), ("veo_variant", "model"), ("minimax_variant", "model")]:
                val = payload.get(alias)
                if val:
                    args += [f"--{flag}", val]

            ref_urls = payload.get("ref_urls", [])
            for ref in ref_urls:
                if ref.startswith("/pv-media"):
                    local = _resolve_local_path(ref)
                    if local:
                        args += ["--image", str(local)]
                else:
                    args += ["--image", ref]

            repeat = max(1, min(4, int(payload.get("repeat", 1))))
            has_batch = payload.get("batch_size") is not None
            if has_batch:
                repeat = 1

            def run_one(_i):
                return _run_cli(*args, timeout=300)

            all_jobs = []
            all_images = []
            first_error = None

            with ThreadPoolExecutor(max_workers=repeat) as pool:
                futures = [pool.submit(run_one, i) for i in range(repeat)]
                for fut in as_completed(futures):
                    data = fut.result()
                    if isinstance(data, list):
                        for job in data:
                            jid = job.get("id", "")
                            if jid:
                                all_jobs.append(jid)
                            url = job.get("result_url", "")
                            if url:
                                all_images.append({"url": url})
                    elif isinstance(data, dict) and "error" in data:
                        if first_error is None:
                            err = data["error"]
                            if isinstance(err, dict):
                                err = err.get("message", json.dumps(err, ensure_ascii=False))
                            first_error = str(err)
                    else:
                        jid = data.get("id", "")
                        if jid:
                            all_jobs.append(jid)
                        url = data.get("result_url", "")
                        if url:
                            all_images.append({"url": url})

            if not all_jobs and not all_images and first_error:
                self._send_json(502, {"error": first_error})
                return

            self._send_json(200, {
                "job_ids": all_jobs,
                "status": "completed",
                "images": all_images,
            })
            return

        self.send_error(404, "Not Found")

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("=" * 60)
    print("  Higgsfield Spotlight (CLI mode)")
    print(f"  http://127.0.0.1:{PORT}")
    print(f"  CLI: {HF_CLI}")
    print(f"  Models: {len(MODEL_CATALOG)}")
    print("=" * 60)
    print("종료: Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n종료")
        server.shutdown()


if __name__ == "__main__":
    main()
