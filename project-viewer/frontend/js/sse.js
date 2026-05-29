// =====================================================================
// SSE — viewer 서버의 favorites.json 변경 감지를 client 에 push 받음
// 모듈 외부에서 callback 을 등록하면 favorites-changed 이벤트마다 호출된다.
// =====================================================================
import { sseSource, setSseSource } from "./state.js";

let _onFavoritesChanged = () => {};

/** favorites-changed 이벤트 시 호출될 callback 등록. */
export function setSSECallback(fn) {
    _onFavoritesChanged = typeof fn === "function" ? fn : () => {};
}

/** SSE 연결 시작. 중복 호출 시 무시. */
export function startSSE() {
    if (sseSource) return;
    try {
        const src = new EventSource("/api/events");
        setSseSource(src);
        src.onmessage = (e) => {
            if (e.data === "favorites-changed") _onFavoritesChanged();
        };
        src.onerror = () => {
            // EventSource 는 기본 자동 재연결. 그대로 둠.
        };
    } catch (err) {
        console.warn("SSE 시작 실패:", err);
    }
}
