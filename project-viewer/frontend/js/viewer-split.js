// =====================================================================
// 보기 탭의 상단 그리드 ↔ 하단 stage 비율 조절 (split resize).
//
// 자기완결적 모듈 — viewer-tab.js 와는 import 만으로 연결. side-effect 로
// 이벤트 / MutationObserver 가 자동 등록된다.
//
// tabs.js 가 section.preview 의 viewer-mode 클래스를 토글하면 자동 반영.
// 비율은 localStorage 영구 저장.
// =====================================================================
import { viewerStage } from "./dom.js";

const SPLIT_KEY = "viewer.splitRatio";
const HEADER_H = 80;            // view-controls + info 가 차지하는 대략 높이
const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;
const DEFAULT_RATIO = 0.5;

const _splitter = document.getElementById("viewer-splitter");
const _previewEl = document.querySelector("section.preview");
const _previewContentEl = document.getElementById("preview-content");

let _splitRatio = (() => {
    try {
        const v = parseFloat(localStorage.getItem(SPLIT_KEY));
        return isFinite(v) && v >= MIN_RATIO && v <= MAX_RATIO ? v : DEFAULT_RATIO;
    } catch { return DEFAULT_RATIO; }
})();

function applyViewerSplit() {
    if (!_previewEl || !_previewContentEl || !viewerStage) return;
    if (!_previewEl.classList.contains("viewer-mode")) {
        _previewContentEl.style.flex = "";
        viewerStage.style.flex = "";
        return;
    }
    const pct = (_splitRatio * 100).toFixed(2);
    const restPct = ((1 - _splitRatio) * 100).toFixed(2);
    _previewContentEl.style.flex = `1 1 ${pct}%`;
    viewerStage.style.flex = `1 1 ${restPct}%`;
}

let _splitDrag = null;
_splitter?.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (!_previewEl?.classList.contains("viewer-mode")) return;
    const rect = _previewEl.getBoundingClientRect();
    _splitDrag = { rect };
    _splitter.classList.add("dragging");
    e.preventDefault();
    e.stopPropagation();
});
document.addEventListener("mousemove", (e) => {
    if (!_splitDrag) return;
    const r = _splitDrag.rect;
    const y = e.clientY - r.top - HEADER_H;
    const usable = Math.max(200, r.height - HEADER_H);
    let ratio = y / usable;
    ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
    _splitRatio = ratio;
    applyViewerSplit();
});
document.addEventListener("mouseup", () => {
    if (!_splitDrag) return;
    _splitDrag = null;
    _splitter?.classList.remove("dragging");
    try { localStorage.setItem(SPLIT_KEY, String(_splitRatio)); } catch {}
});

// viewer-mode 진입/탈출 시 split 적용. tabs.js 가 클래스 토글하므로 MutationObserver 로 감지.
if (_previewEl) {
    new MutationObserver(() => applyViewerSplit()).observe(_previewEl, { attributes: true, attributeFilter: ["class"] });
    applyViewerSplit();
}
