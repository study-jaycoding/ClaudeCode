// 라이트박스 (확대 보기) — 이미지/비디오 + 메타데이터 표시.

import { lightbox, lightboxBody, lightboxClose } from "./dom.js";
import { escapeHtml } from "./utils.js";

export function openLightbox(src, isVideo, meta) {
    const media = isVideo
        ? `<video src="${src}" controls autoplay loop></video>`
        : `<img src="${src}" alt="Generated" />`;
    let info = "";
    if (meta && (meta.prompt || meta.creator || meta.credits_per_job != null)) {
        const rows = [];
        const row = (label, val) => rows.push(`<div class="lb-row"><span class="lb-k">${label}</span><span class="lb-v">${val}</span></div>`);
        if (meta.model) row("Model", escapeHtml(meta.model));
        if (meta.creator) row("Creator", escapeHtml(meta.creator));
        if (meta.credits_per_job != null) row("Credits", `✦ ${meta.credits_per_job}`);
        if (meta.aspect_ratio) row("Ratio", escapeHtml(meta.aspect_ratio));
        if (meta.resolution) row("Resolution", escapeHtml(meta.resolution));
        if (meta.quality) row("Quality", escapeHtml(meta.quality));
        if (meta.prompt) {
            rows.push(`<div class="lb-row lb-prompt"><span class="lb-k">Prompt</span><span class="lb-v">${escapeHtml(meta.prompt)}</span></div>`);
        }
        info = `<div class="lb-meta">${rows.join("")}</div>`;
    }
    lightboxBody.innerHTML = `<div class="lb-media">${media}</div>${info}`;
    lightbox.classList.remove("hidden");
}

export function closeLightbox() {
    lightbox.classList.add("hidden");
    lightboxBody.innerHTML = "";
}

export function isLightboxOpen() {
    return !lightbox.classList.contains("hidden");
}

export function bindLightbox() {
    lightboxClose.addEventListener("click", closeLightbox);
    lightbox.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });
}
