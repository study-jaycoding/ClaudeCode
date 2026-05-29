// =====================================================================
// 라이트박스 — 이미지/비디오/텍스트(json 등) 확대
// =====================================================================
import { lightbox, lightboxStage, lightboxCaption, lightboxClose } from "./dom.js";
import { escapeHtml, humanSize } from "./utils.js";
import { apiGetFile } from "./api.js";

function isJsonPath(p) { return String(p || "").toLowerCase().endsWith(".json"); }

function tryPrettyJson(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

async function renderTextLightbox(project, node) {
    lightboxStage.innerHTML = `<pre class="lb-text loading">불러오는 중…</pre>`;
    try {
        const { ok, data } = await apiGetFile(project, node.path);
        if (!ok) {
            lightboxStage.innerHTML = `<pre class="lb-text error">${escapeHtml(data.error || "오류")}</pre>`;
            return;
        }
        const body = isJsonPath(node.path) ? tryPrettyJson(data.content) : data.content;
        const note = data.truncated
            ? `<div class="lb-text-warn">⚠ 처음 1MB 만 표시 (전체 ${humanSize(data.size)})</div>` : "";
        lightboxStage.innerHTML = note + `<pre class="lb-text">${escapeHtml(body)}</pre>`;
    } catch (err) {
        lightboxStage.innerHTML = `<pre class="lb-text error">${escapeHtml(err.message)}</pre>`;
    }
}

export function openLightbox(project, node) {
    const url = `/media?project=${encodeURIComponent(project)}&path=${encodeURIComponent(node.path)}`;
    lightbox.classList.remove("hidden");
    lightboxCaption.textContent = `${project} / ${node.path}`;
    if (node.kind === "image") {
        lightboxStage.innerHTML = `<img src="${url}" alt="${escapeHtml(node.name)}" />`;
    } else if (node.kind === "video") {
        lightboxStage.innerHTML = `<video src="${url}" controls autoplay></video>`;
    } else if (node.kind === "text") {
        renderTextLightbox(project, node);
    } else {
        lightboxStage.innerHTML = `<div style="color:#cdd3df">미리보기를 지원하지 않는 형식입니다.</div>`;
    }
}

export function closeLightbox() {
    lightboxStage.innerHTML = "";
    lightbox.classList.add("hidden");
}

export function isLightboxOpen() {
    return !lightbox.classList.contains("hidden");
}

// 모듈 로드 시 자동 이벤트 등록 (닫기 버튼 + 오버레이 클릭)
lightboxClose.addEventListener("click", closeLightbox);
lightbox.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });
