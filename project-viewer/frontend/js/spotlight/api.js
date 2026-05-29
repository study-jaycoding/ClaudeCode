// 백엔드 fetch 래퍼.

export async function fetchModels() {
    const res = await fetch("/api/sp/models");
    return res.json();
}

export async function fetchProjects() {
    const res = await fetch("/api/projects");
    return res.json();
}

export async function fetchBalance() {
    const res = await fetch("/api/sp/balance");
    return res.json();
}

export async function fetchFavorites() {
    const res = await fetch("/api/favorites");
    return res.json();
}

export async function fetchJobStatus(jobId) {
    const res = await fetch(`/api/sp/jobs/${jobId}`);
    if (!res.ok) throw new Error(`job status ${res.status}`);
    return res.json();
}

export async function postLogin() {
    const res = await fetch("/api/sp/login", { method: "POST" });
    const data = await res.json();
    return { ok: res.ok, data };
}

export async function postGenerate(body) {
    const res = await fetch("/api/sp/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    return { ok: res.ok, data };
}

export async function postCost(body) {
    const res = await fetch("/api/sp/cost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`cost ${res.status}`);
    return res.json();
}

export async function postUpload(file) {
    const res = await fetch("/api/sp/ref-upload", {
        method: "POST",
        headers: {
            "Content-Type": file.type || "image/png",
            "X-File-Name": encodeURIComponent(file.name),
        },
        body: file,
    });
    if (!res.ok) throw new Error(`upload ${res.status}`);
    return res.json();
}
