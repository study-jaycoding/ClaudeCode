"""이미지/비디오 생성 흐름."""

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from .cli import run_cli
from .projects_ops import (
    resolve_media_path,
    download_to_project,
    write_sidecar,
    append_favorite,
)

PASSTHROUGH_KEYS = {
    "resolution", "quality", "mode", "batch_size",
    "duration", "sound", "genre",
}

MODEL_ALIAS_FLAGS = [
    ("flux_variant", "model"),
    ("veo_variant", "model"),
    ("minimax_variant", "model"),
]

METADATA_EXTRA_KEYS = (
    "resolution", "quality", "mode", "duration", "sound", "genre",
    "flux_variant", "veo_variant", "minimax_variant",
    "negative_prompt", "style",
)


def build_args(payload: dict) -> tuple[list[str], list[str]]:
    model = payload["model"]
    prompt = payload["prompt"]
    create = ["generate", "create", model, "--prompt", prompt, "--wait"]
    cost = ["generate", "cost", model, "--prompt", prompt]

    aspect_ratio = payload.get("aspect_ratio")
    if aspect_ratio:
        create += ["--aspect_ratio", aspect_ratio]
        cost += ["--aspect_ratio", aspect_ratio]

    for key in PASSTHROUGH_KEYS:
        val = payload.get(key)
        if val is not None:
            create += [f"--{key}", str(val)]
            cost += [f"--{key}", str(val)]

    for alias, flag in MODEL_ALIAS_FLAGS:
        val = payload.get(alias)
        if val:
            create += [f"--{flag}", val]
            cost += [f"--{flag}", val]

    for ref in payload.get("ref_urls", []) or []:
        # viewer 의 /media URL 또는 spotlight 의 /pv-media URL
        if ref.startswith("/media") or ref.startswith("/pv-media"):
            local = resolve_media_path(ref)
            if local:
                create += ["--image", str(local)]
        else:
            create += ["--image", ref]

    return create, cost


def _collect_one(data) -> tuple[list[str], list[dict], str | None]:
    jobs, images, err = [], [], None
    if isinstance(data, list):
        for job in data:
            jid = job.get("id", "")
            if jid:
                jobs.append(jid)
            url = job.get("result_url", "")
            if url:
                images.append({"url": url})
    elif isinstance(data, dict) and "error" in data:
        e = data["error"]
        if isinstance(e, dict):
            e = e.get("message", json.dumps(e, ensure_ascii=False))
        err = str(e)
    else:
        jid = data.get("id", "")
        if jid:
            jobs.append(jid)
        url = data.get("result_url", "")
        if url:
            images.append({"url": url})
    return jobs, images, err


def run_parallel(create_args: list[str], repeat: int) -> tuple[list[str], list[dict], str | None]:
    all_jobs, all_images, first_err = [], [], None

    def run_one(_i):
        return run_cli(*create_args, timeout=300)

    with ThreadPoolExecutor(max_workers=repeat) as pool:
        futures = [pool.submit(run_one, i) for i in range(repeat)]
        for fut in as_completed(futures):
            jobs, images, err = _collect_one(fut.result())
            all_jobs.extend(jobs)
            all_images.extend(images)
            if err and first_err is None:
                first_err = err

    return all_jobs, all_images, first_err


def fetch_cost_and_account(cost_args: list[str]) -> tuple[float, str]:
    cost_data = run_cli(*cost_args, timeout=15)
    cost_per_job = cost_data.get("credits_exact") or cost_data.get("credits") or 0
    cost_per_job = float(cost_per_job)

    acct = run_cli("account", "status", timeout=10)
    email = acct.get("email", "") if isinstance(acct, dict) else ""
    return cost_per_job, email


def build_metadata(payload: dict, jobs: list[str], cost_per_job: float, email: str) -> dict:
    total_cost = cost_per_job * len(jobs) if jobs else cost_per_job
    metadata = {
        "model": payload["model"],
        "prompt": payload["prompt"],
        "aspect_ratio": payload.get("aspect_ratio"),
        "credits": total_cost,
        "credits_per_job": cost_per_job,
        "creator": email,
        "created_at": datetime.now().isoformat(),
        "job_ids": jobs,
    }
    disp = payload.get("display_prompt")
    if disp and disp != payload.get("prompt"):
        metadata["display_prompt"] = disp
    src_ids = payload.get("source_ids") or []
    if src_ids:
        metadata["source_ids"] = list(src_ids)
    # favorite 매칭이 안 되는 외부 ref 도 식별 가능하도록 ref_urls 도 보존
    ref_urls = payload.get("ref_urls") or []
    if ref_urls:
        metadata["ref_urls"] = list(ref_urls)
    for k in METADATA_EXTRA_KEYS:
        v = payload.get(k)
        if v is not None and v != "":
            metadata[k] = v
    return metadata


def save_to_project(images: list[dict], project: str, source_ids: list, metadata: dict) -> list[dict]:
    saved = []
    for img in images:
        url = img.get("url", "")
        if not url:
            continue
        rec = download_to_project(url, project, "Result")
        if not rec:
            continue
        write_sidecar(project, rec["path"], metadata)
        fav = append_favorite(project, rec["path"], source_ids)
        saved.append({
            "name": rec["name"],
            "path": rec["path"],
            "size": rec["size"],
            "favorite_id": (fav or {}).get("id"),
        })
    return saved


def generate(payload: dict) -> tuple[int, dict]:
    model = payload.get("model", "")
    prompt = payload.get("prompt", "")
    if not model or not prompt:
        return 400, {"error": "model 과 prompt 는 필수입니다."}

    create_args, cost_args = build_args(payload)

    repeat = max(1, min(4, int(payload.get("repeat", 1))))
    if payload.get("batch_size") is not None:
        repeat = 1

    all_jobs, all_images, first_err = run_parallel(create_args, repeat)

    if not all_jobs and not all_images and first_err:
        return 502, {"error": first_err}

    cost_per_job, email = fetch_cost_and_account(cost_args)
    metadata = build_metadata(payload, all_jobs, cost_per_job, email)

    for img in all_images:
        img["metadata"] = metadata

    auto_download = bool(payload.get("auto_download", True))
    target_project = (payload.get("project") or "").strip()
    source_ids = payload.get("source_ids") or []
    saved = []
    if auto_download and target_project and all_images:
        saved = save_to_project(all_images, target_project, source_ids, metadata)

    return 200, {
        "job_ids": all_jobs,
        "status": "completed",
        "images": all_images,
        "saved": saved,
        "metadata": metadata,
    }
