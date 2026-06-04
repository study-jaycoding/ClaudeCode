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

/** GET /api/favorites?project=<name> — 그 프로젝트의 favorites 만.
 *  project 없으면 모든 프로젝트 합쳐서 반환 (cross-project 검색용). */
export async function apiGetFavorites(project) {
    const q = project ? "?project=" + encodeURIComponent(project) : "";
    const res = await fetch("/api/favorites" + q);
    return res.json();
}

/** POST /api/favorites?project=<name> — 그 프로젝트의 favorites 통째 덮어쓰기.
 *  body 는 그 프로젝트의 favorites 배열만. project 없으면 backend 가 거부. */
export function apiPersistFavorites(project, favorites) {
    if (!project) return Promise.resolve();  // 프로젝트 없으면 noop
    const q = "?project=" + encodeURIComponent(project);
    return fetch("/api/favorites" + q, J(favorites)).catch(() => {});
}

/** POST /api/sp/recover — 큐 entry 의 job_ids 를 다시 조회해서 결과 가져옴.
 *  ip_detected (사이트 confirm 필요) 케이스에 사용자가 사이트 다녀온 후 호출. */
export async function apiSpRecoverJob(queueId) {
    const res = await fetch("/api/sp/recover", J({ queue_id: queueId }));
    let data = null;
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
}

/** GET /api/colors?project=<name> — 그 프로젝트 카드 컬러 마커 (path → color). */
export async function apiGetColors(project) {
    if (!project) return { colors: {} };
    const res = await fetch("/api/colors?project=" + encodeURIComponent(project));
    return res.json();
}

/** POST /api/colors — paths 일괄 색 변경. color=null 이면 제거. */
export async function apiSetColors(project, paths, color) {
    if (!project || !paths || paths.length === 0) return { ok: false, colors: {} };
    const body = { project, paths, color: color || null };
    const res = await fetch("/api/colors", J(body));
    return res.json();
}

/** GET /api/comments?project=<name> — 그 프로젝트 전체 코멘트 ({path: [...]}) */
export async function apiGetComments(project) {
    if (!project) return { comments: {} };
    const res = await fetch("/api/comments?project=" + encodeURIComponent(project));
    return res.json();
}

// 코멘트 API 들 — status 가 ok 가 아니거나 JSON 파싱 실패 시 {ok:false, error} 반환.
// 서버가 새 endpoint 를 모르면 (재시작 안 됨) 404 HTML 을 받아 res.json() 이 던지므로 catch.
async function _safeJson(res, fallbackError) {
    try {
        const data = await res.json();
        if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
        return data;
    } catch {
        return { ok: false, error: fallbackError + ` (HTTP ${res.status})` };
    }
}

/** POST /api/comments — 단일 코멘트 추가. 응답에 새 entry. */
export async function apiAddComment(project, path, author, text) {
    try {
        const res = await fetch("/api/comments", J({ project, path, author, text }));
        return await _safeJson(res, "코멘트 API 응답 파싱 실패 — 서버 재시작이 필요할 수 있습니다");
    } catch (e) {
        return { ok: false, error: "네트워크 오류: " + e.message };
    }
}

/** POST /api/comments/reply — 기존 코멘트에 답글 추가. */
export async function apiAddReply(project, path, parentId, author, text) {
    try {
        const res = await fetch("/api/comments/reply", J({ project, path, parentId, author, text }));
        return await _safeJson(res, "답글 API 응답 파싱 실패");
    } catch (e) {
        return { ok: false, error: "네트워크 오류: " + e.message };
    }
}

/** POST /api/comments/delete — 단일 코멘트 또는 답글 제거. */
export async function apiDeleteComment(project, path, id) {
    try {
        const res = await fetch("/api/comments/delete", J({ project, path, id }));
        return await _safeJson(res, "코멘트 삭제 API 실패");
    } catch (e) {
        return { ok: false, error: "네트워크 오류: " + e.message };
    }
}

/** POST /api/comments/update — 코멘트 본문 수정. */
export async function apiUpdateComment(project, path, id, text) {
    try {
        const res = await fetch("/api/comments/update", J({ project, path, id, text }));
        return await _safeJson(res, "코멘트 수정 API 실패");
    } catch (e) {
        return { ok: false, error: "네트워크 오류: " + e.message };
    }
}

/** GET /api/sp/jobs?status=&project=&limit= — Spotlight Job Queue 이력 */
export async function apiGetJobs({ status, project, limit } = {}) {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (project) params.set("project", project);
    if (limit) params.set("limit", String(limit));
    const q = params.toString();
    const res = await fetch("/api/sp/jobs" + (q ? "?" + q : ""));
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
}

/** POST /api/sp/jobs/clear-finished — 완료/실패 항목 일괄 제거.
 *  onlyStatus = "completed" | "failed" 면 그 상태만, 기본은 둘 다. */
export async function apiClearFinishedJobs(onlyStatus) {
    const q = (onlyStatus === "completed" || onlyStatus === "failed")
        ? "?status=" + onlyStatus : "";
    const res = await fetch("/api/sp/jobs/clear-finished" + q, { method: "POST" });
    return res.json();
}


/** POST /api/sp/jobs/remove — 단일 job 제거 */
export async function apiRemoveJob(id) {
    const res = await fetch("/api/sp/jobs/remove", J({ id }));
    return res.json();
}

/** GET /api/sp/jobs/<higgsfield_job_id> — Higgsfield 의 단일 job 현재 상태 조회 */
export async function apiSpGetJobStatus(higgsfieldJobId) {
    const res = await fetch("/api/sp/jobs/" + encodeURIComponent(higgsfieldJobId));
    let data = null;
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
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
