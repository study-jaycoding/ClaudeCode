// =====================================================================
// 그리드 선택 + lasso 드래그 선택 + 트리 라벨 동기화
// 카드 click / Ctrl-click / Shift-click + section.preview lasso 드래그
// =====================================================================
import {
    lastSelectedCard, setLastSelectedCard,
    lassoStart, setLassoStart,
    lassoActive, setLassoActive,
    lassoPreSelected, setLassoPreSelected,
    suppressClickUntil, setSuppressClickUntil,
} from "./state.js";
import { previewContent, previewSection, lasso } from "./dom.js";
import { cssQueryEscape } from "./utils.js";

// 외부 callback (popup.js 분리 후 등록)
let _closeContextPopup = () => {};
export function setCloseContextPopupCallback(fn) {
    _closeContextPopup = typeof fn === "function" ? fn : () => {};
}

/** 카드 draggable 동기화 — makeCardDraggable 이 이미 항상 true 로 설정하므로 no-op. */
export function refreshDraggable() {
    // 모든 파일 카드는 makeCardDraggable() 시점에 draggable=true 로 설정됨.
    // 선택 상태와 무관하게 항상 외부 드래그 가능. 기존 호출처 호환용으로 보존.
}

/** 카드 선택. Shift = 범위 선택, Ctrl/Meta = 토글 추가, 그 외 = 단일 선택. */
export function selectCard(card, e) {
    const all = Array.from(previewContent.querySelectorAll(".card"));
    if (e && e.shiftKey && lastSelectedCard && all.includes(lastSelectedCard)) {
        const start = all.indexOf(lastSelectedCard);
        const end = all.indexOf(card);
        const [a, b] = [Math.min(start, end), Math.max(start, end)];
        all.forEach((c, i) => c.classList.toggle("selected", i >= a && i <= b));
    } else if (e && (e.ctrlKey || e.metaKey)) {
        card.classList.toggle("selected");
        setLastSelectedCard(card);
    } else {
        all.forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
        setLastSelectedCard(card);
    }
    syncTreeSelection();
    refreshDraggable();
}

export function getSelectedCards() {
    return Array.from(previewContent.querySelectorAll(".card.selected"));
}

export function getSelectedPaths() {
    return getSelectedCards().map((c) => c.dataset.path).filter(Boolean);
}

export function clearSelection() {
    previewContent.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
    setLastSelectedCard(null);
    syncTreeSelection();
    refreshDraggable();
    _closeContextPopup();
}

/** 그리드 선택 상태를 트리 라벨에도 반영. */
export function syncTreeSelection() {
    document.querySelectorAll(".tree .file-label.selected, .tree .dir-label.selected")
        .forEach((l) => l.classList.remove("selected"));
    for (const path of getSelectedPaths()) {
        const label = document.querySelector(
            `.tree .file-label[data-path="${cssQueryEscape(path)}"]`
        );
        if (label) label.classList.add("selected");
    }
}

// =====================================================================
// lasso 드래그 선택 — section.preview 위 빈 영역에서 mousedown 시 시작
// =====================================================================

// lasso DOM 이 mouse hit-test 를 가로채지 않도록 명시 (CSS 누락 방어).
lasso.style.pointerEvents = "none";

// 미리보기 영역의 빈 공간 클릭 시 선택 해제
previewContent.addEventListener("click", (e) => {
    if (e.target === previewContent || e.target.classList.contains("grid")) {
        clearSelection();
    }
});

// capture 단계에서 lasso 직후 click 을 잡아 카드 click 호출을 막음 (lasso 결과 유지)
document.addEventListener("click", (e) => {
    if (Date.now() < suppressClickUntil) {
        e.stopPropagation();
        e.preventDefault();
    }
}, true);

// section.preview 전체에서 mousedown 을 받는다 — 그리드 끝 아래 빈 영역이
// previewContent 박스 밖일 때도 lasso 가 시작될 수 있도록.
previewSection.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (!previewContent.querySelector(".grid")) return;
    if (e.target.closest("button, a, input, textarea, select, option, label")) return;
    // 카드 위 mousedown 은 native drag 우선 (lasso 시작 X) — 한 번에 끌 수 있도록.
    if (e.target.closest(".card")) return;
    e.preventDefault();
    setLassoStart({ x: e.clientX, y: e.clientY, ctrl: e.ctrlKey || e.metaKey });
    setLassoActive(false);
    setLassoPreSelected(lassoStart.ctrl ? new Set(getSelectedCards()) : null);
});

document.addEventListener("mousemove", (e) => {
    if (!lassoStart) return;
    const dx = e.clientX - lassoStart.x;
    const dy = e.clientY - lassoStart.y;
    if (!lassoActive && Math.abs(dx) + Math.abs(dy) > 4) {
        setLassoActive(true);
        if (!lassoStart.ctrl) clearSelection();
        lasso.classList.remove("hidden");
    }
    if (!lassoActive) return;
    const x = Math.min(e.clientX, lassoStart.x);
    const y = Math.min(e.clientY, lassoStart.y);
    const w = Math.abs(dx);
    const h = Math.abs(dy);
    lasso.style.left = x + "px";
    lasso.style.top = y + "px";
    lasso.style.width = w + "px";
    lasso.style.height = h + "px";
    const rx2 = x + w, ry2 = y + h;
    previewContent.querySelectorAll(".card").forEach((card) => {
        const r = card.getBoundingClientRect();
        const overlap = !(r.right < x || r.left > rx2 || r.bottom < y || r.top > ry2);
        if (lassoStart.ctrl) {
            if (overlap) card.classList.add("selected");
            else if (!lassoPreSelected.has(card)) card.classList.remove("selected");
        } else {
            card.classList.toggle("selected", overlap);
        }
    });
    syncTreeSelection();
});

document.addEventListener("mouseup", () => {
    if (lassoActive) {
        lasso.classList.add("hidden");
        lasso.style.width = "0";
        lasso.style.height = "0";
        refreshDraggable();
        // mouseup 직후 발화되는 click 을 250ms 동안 무시 → lasso 결과 유지
        setSuppressClickUntil(Date.now() + 250);
    }
    setLassoStart(null);
    setLassoActive(false);
    setLassoPreSelected(null);
});
