// =====================================================================
// SSE — viewer 서버에서 favorites.json / spotlight_jobs.json 변경 알림
// 모듈 외부에서 callback 을 등록하면 해당 이벤트마다 호출된다.
// =====================================================================
import { sseSource, setSseSource } from "./state.js";

let _onFavoritesChanged = () => {};
let _onJobsChanged = () => {};

/** favorites-changed 이벤트 시 호출될 callback 등록. */
export function setSSECallback(fn) {
    _onFavoritesChanged = typeof fn === "function" ? fn : () => {};
}

/** jobs-changed 이벤트 시 호출될 callback 등록 (Queue 탭/진행 표시 갱신용). */
export function setJobsSSECallback(fn) {
    _onJobsChanged = typeof fn === "function" ? fn : () => {};
}

/** SSE 연결 시작. 중복 호출 시 무시. */
export function startSSE() {
    if (sseSource) return;
    try {
        const src = new EventSource("/api/events");
        setSseSource(src);
        src.onmessage = (e) => {
            if (e.data === "favorites-changed") _onFavoritesChanged();
            else if (e.data === "jobs-changed") _onJobsChanged();
        };
        src.onerror = () => {
            // EventSource 는 기본 자동 재연결. 그대로 둠.
        };
    } catch (err) {
        console.warn("SSE 시작 실패:", err);
    }
}
