// =====================================================================
// API wrappers — viewer 백엔드의 모든 endpoint 호출을 한 곳에서 관리
// 반환값은 { ok, status, data } 형태 또는 응답 자체.
// =====================================================================

const J = (data) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
});

/** GET /api/projects */
export async function apiListProjects() {
    const res = await fetch("/api/projects");
    return res.json();
}

/** GET /api/tree?project=... */
export async function apiGetTree(project) {
    const res = await fetch(`/api/tree?project=${encodeURIComponent(project)}`);
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
}

/** GET /api/favorites */
export async function apiGetFavorites() {
    const res = await fetch("/api/favorites");
    return res.json();
}

/** POST /api/favorites — body 는 favorites 배열. fire-and-forget. */
export function apiPersistFavorites(favorites) {
    return fetch("/api/favorites", J(favorites)).catch(() => {});
}

/** GET /api/meta?project&path */
export async function apiGetMeta(project, path) {
    const res = await fetch(
        `/api/meta?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`
    );
    return res.json();
}

/** GET /api/file?project&path — 텍스트 미리보기 */
export async function apiGetFile(project, path) {
    const res = await fetch(
        `/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`
    );
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
}

/** POST /api/move { project, from, toDir } */
export async function apiMove(project, from, toDir) {
    const res = await fetch("/api/move", J({ project, from, toDir }));
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
}

/** POST /api/rename { project, path, newName } */
export async function apiRename(project, path, newName) {
    const res = await fetch("/api/rename", J({ project, path, newName }));
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
}

/** POST /api/delete { project, path } */
export async function apiMkdir(project, parent, name) {
    const res = await fetch("/api/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, parent, name }),
    });
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
}

export async function apiDelete(project, path) {
    const res = await fetch("/api/delete", J({ project, path }));
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
}

/** POST /api/reveal { project, path } — 탐색기 열기 */
export async function apiReveal(project, path) {
    const res = await fetch("/api/reveal", J({ project, path }));
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
}

/** POST /api/upload?project&dir, headers X-File-Name, body=file (raw bytes) */
export async function apiUpload(project, dir, file) {
    const url = `/api/upload?project=${encodeURIComponent(project)}&dir=${encodeURIComponent(dir)}`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "X-File-Name": encodeURIComponent(file.name),
            "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    const data = await res.json();
    return { ok: true, status: res.status, data };
}

/** POST /api/fetch-url { project, dir, url } — 서버가 URL 다운로드 */
export async function apiFetchUrl(project, dir, url) {
    const res = await fetch("/api/fetch-url", J({ project, dir, url }));
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
}
