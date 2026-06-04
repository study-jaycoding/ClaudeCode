// 상단 헤더의 정보 메시지 영역 — 이동/이름변경/오류 같은 일시적 알림 표시.
// previewInfo (breadcrumb) 를 덮어쓰지 않도록 헤더에 별도 자리.

const el = document.getElementById("info-toast");
let _timer = null;

/** 정보 메시지 표시 — kind: "info" | "ok" | "warn" | "error". 기본 3초 후 사라짐. */
export function showInfo(text, kind = "info", durationMs = 3000) {
    if (!el) return;
    if (_timer) clearTimeout(_timer);
    el.className = "info-toast info-" + kind + " visible";
    el.textContent = text || "";
    if (!text) {
        el.classList.remove("visible");
        return;
    }
    if (durationMs > 0) {
        _timer = setTimeout(() => {
            el.classList.remove("visible");
            _timer = null;
        }, durationMs);
    }
}

export function showOk(text, ms) { showInfo(text, "ok", ms); }
export function showWarn(text, ms) { showInfo(text, "warn", ms); }
export function showError(text, ms) { showInfo(text, "error", ms ?? 5000); }
