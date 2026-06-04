// =====================================================================
// 라이트박스 — 이미지/비디오/텍스트(json 등) 확대
// =====================================================================
import { lightbox, lightboxStage, lightboxCaption, lightboxClose, previewContent } from "./dom.js";
import { escapeHtml, humanSize, findNodeByPath } from "./utils.js";
import { apiGetFile } from "./api.js";
import { currentProject, rootTree } from "./state.js";

// 현재 라이트박스가 보여주는 항목 — ←/→ navigation 의 기준점
let _currentProject = "";
let _currentPath = "";

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
    _currentProject = project;
    _currentPath = node.path || "";
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
    _currentProject = "";
    _currentPath = "";
}

export function isLightboxOpen() {
    return !lightbox.classList.contains("hidden");
}

// ←/→ 로 같은 그리드 안의 image/video/text 항목 사이 이동.
// 현재 그리드의 .card[data-path] 중 lightbox 가 보여줄 수 있는 종류만 후보.
// previewContent 의 현재 카드 순서를 그대로 사용 (정렬/그룹 헤더 반영됨).
export function lightboxStep(direction) {
    if (!isLightboxOpen() || !_currentProject || !_currentPath || !rootTree) return false;
    const cards = Array.from(previewContent.querySelectorAll(".card[data-path]"))
        .filter((c) => c.classList.contains("kind-image")
                    || c.classList.contains("kind-video")
                    || c.classList.contains("kind-text"));
    if (cards.length === 0) return false;
    const idx = cards.findIndex((c) => c.dataset.path === _currentPath);
    if (idx === -1) return false;
    const next = idx + (direction > 0 ? 1 : -1);
    if (next < 0 || next >= cards.length) return false;  // 끝에서 막힘 (wrap 안 함)
    const targetCard = cards[next];
    const targetPath = targetCard.dataset.path;
    const node = findNodeByPath(rootTree, targetPath);
    if (!node) return false;
    // 그리드 selection 도 같이 옮겨서 라이트박스 닫고 돌아왔을 때 자연스럽게
    previewContent.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
    targetCard.classList.add("selected");
    targetCard.scrollIntoView({ block: "nearest" });
    openLightbox(_currentProject, node);
    return true;
}

// 라이트박스가 열려있을 때만 ←/→ 가로채서 navigation.
// keyboard.js 보다 먼저 잡기 위해 capture phase 에 등록.
document.addEventListener("keydown", (e) => {
    if (!isLightboxOpen()) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    // input/textarea 안에서는 무시 (라이트박스 안 텍스트 보기 모드에서 검색하는 등)
    const ae = document.activeElement;
    if (ae && (["INPUT", "TEXTAREA"].includes(ae.tagName) || ae.isContentEditable)) return;
    if (lightboxStep(e.key === "ArrowRight" ? 1 : -1)) {
        e.preventDefault();
        e.stopPropagation();
    }
}, true);

// 모듈 로드 시 자동 이벤트 등록 (닫기 버튼 + 오버레이 클릭)
lightboxClose.addEventListener("click", closeLightbox);
lightbox.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });
