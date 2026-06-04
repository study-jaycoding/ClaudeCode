// =====================================================================
// 사이드바 우측 가장자리 드래그로 panel 너비 조절.
// 너비는 localStorage 에 저장 → 재실행 시 복원.
// collapsed 상태에서는 handle 자체가 hidden (CSS).
// =====================================================================
const SIDEBAR_WIDTH_KEY = "viewer.sidebarWidth";
const MIN_WIDTH = 200;
const MAX_WIDTH = 800;
const DEFAULT_WIDTH = 320;

const sidebar = document.querySelector("aside.sidebar");
const handle = document.querySelector(".sidebar-resize-handle");

function _readSavedWidth() {
    try {
        const v = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || "", 10);
        if (Number.isFinite(v) && v >= MIN_WIDTH && v <= MAX_WIDTH) return v;
    } catch {}
    return DEFAULT_WIDTH;
}

function _applyWidth(w) {
    if (!sidebar) return;
    sidebar.style.width = w + "px";
}

// 시작 시 저장된 너비 복원 + 혹시 직전 세션의 stuck 상태 해제 (안전망)
_applyWidth(_readSavedWidth());
document.body.classList.remove("sidebar-resizing");

if (handle && sidebar) {
    let dragging = false;

    function _endDrag() {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove("dragging");
        document.body.classList.remove("sidebar-resizing");
        try {
            const cur = parseInt(sidebar.style.width, 10);
            if (Number.isFinite(cur)) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(cur));
        } catch {}
    }

    handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        dragging = true;
        handle.classList.add("dragging");
        document.body.classList.add("sidebar-resizing");
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const rect = sidebar.getBoundingClientRect();
        const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX - rect.left));
        _applyWidth(w);
    });

    // 정상 종료
    document.addEventListener("mouseup", _endDrag);
    // 종료 안전망 — 창 밖에서 mouseup 이 발생하거나 포커스를 잃거나 마우스가
    // 페이지 밖으로 나간 경우에도 stuck 상태 해제 (body.sidebar-resizing 가
    // 남아있으면 pointer-events: none 으로 모든 drag 가 죽음).
    window.addEventListener("blur", _endDrag);
    window.addEventListener("mouseleave", _endDrag);
    document.addEventListener("visibilitychange", _endDrag);

    // 더블클릭으로 기본 너비 복원
    handle.addEventListener("dblclick", () => {
        _applyWidth(DEFAULT_WIDTH);
        try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(DEFAULT_WIDTH)); } catch {}
    });
}
