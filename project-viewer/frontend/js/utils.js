// =====================================================================
// 순수 유틸리티 함수 — DOM/state 의존 없음
// =====================================================================

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

export function humanSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

export function kindIcon(kind) {
    return kind === "image" ? "🖼️" : kind === "video" ? "🎬" : kind === "text" ? "📄" : "📦";
}

export function findNodeByPath(tree, path) {
    if (!tree) return null;
    if (path === "" || path == null) return tree;
    let node = tree;
    for (const part of path.split("/")) {
        if (!node.children) return null;
        const next = node.children.find((c) => c.name === part);
        if (!next) return null;
        node = next;
    }
    return node;
}

export function kindFromPath(path) {
    const ext = (path.split(".").pop() || "").toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return "image";
    if (["mp4", "webm", "mov", "mkv", "avi", "m4v"].includes(ext)) return "video";
    if ([
        "txt", "md", "json", "py", "js", "ts", "jsx", "tsx",
        "html", "css", "scss", "log", "yaml", "yml", "ini",
        "conf", "cfg", "csv", "xml", "bat", "sh", "ps1",
    ].includes(ext)) return "text";
    return "other";
}

export function mimeFromPath(path) {
    const ext = (path.split(".").pop() || "").toLowerCase();
    const map = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
        bmp: "image/bmp", mp4: "video/mp4", webm: "video/webm",
    };
    return map[ext] || "application/octet-stream";
}

export function cssQueryEscape(s) {
    return String(s).replace(/(["\\])/g, "\\$1");
}

export function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Result/ 로 시작하는 path = 자동 생성물 (파란 마커, 토글 불가). */
export function isGeneratedPath(path) {
    return String(path || "").startsWith("Result/");
}
