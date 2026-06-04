// 백엔드 fetch 래퍼.

export async function fetchModels() {
    const res = await fetch("/api/models");
    return res.json();
}

export async function fetchProjects() {
    const res = await fetch("/api/projects");
    return res.json();
}

export async function fetchBalance() {
    const res = await fetch("/api/balance");
    return res.json();
}

export async function fetchFavorites(project) {
    const q = project ? "?project=" + encodeURIComponent(project) : "";
    const res = await fetch("/api/favorites" + q);
    return res.json();
}

export async function fetchJobStatus(jobId) {
    const res = await fetch(`/api/jobs/${jobId}`);
    if (!res.ok) throw new Error(`job status ${res.status}`);
    return res.json();
}

export async function postLogin() {
    const res = await fetch("/api/login", { method: "POST" });
    const data = await res.json();
    return { ok: res.ok, data };
}

export async function postGenerate(body) {
    const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    return { ok: res.ok, data };
}

export async function postSave(body) {
    const res = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    return { ok: res.ok, data };
}

export async function postUpload(file) {
    const res = await fetch("/api/upload", {
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
