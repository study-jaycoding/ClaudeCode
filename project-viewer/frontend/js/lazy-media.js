// =====================================================================
// 카드 미디어 lazy 로드 — viewport 진입 시에만 src/poster 설정.
//
// 썸네일 자체는 서버가 사전 생성·디스크 캐시 (/thumb endpoint, Pillow + ffmpeg).
// 클라이언트는 그 작은 JPG 를 HTTP cache (max-age=31536000, immutable) 로 보관.
// 원본 디코드 없음 → 카드 표시 비용이 ~100배 감소.
//
// 이 모듈의 책임은 단 하나: viewport 밖 카드는 fetch 자체를 안 보냄
// (브라우저의 <img loading="lazy"> 는 동작하지만 <video> 는 표준 X).
//
// 사용법:
//   <img   data-lazy-src="/thumb?...">                                 ← 카드 이미지
//   <video data-lazy-poster="/thumb?..." preload="none" muted></video> ← 카드 비디오
//   ↓ DOM 삽입 후
//   lazyScan(parent)
// =====================================================================

const ROOT_MARGIN = "200px";
const THRESHOLD = 0.01;

let _io = null;
function _getIO() {
    if (_io) return _io;
    _io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            _io.unobserve(e.target);
            _activate(e.target);
        }
    }, { rootMargin: ROOT_MARGIN, threshold: THRESHOLD });
    return _io;
}

function _activate(el) {
    if (!el.isConnected) return;
    if (el.tagName === "IMG") {
        const src = el.dataset.lazySrc;
        if (src) { el.src = src; delete el.dataset.lazySrc; }
        return;
    }
    if (el.tagName === "VIDEO") {
        // 카드 비디오는 재생 X — poster 만 보여주면 된다 (디코드 0).
        // 실제 재생은 stage / lightbox 가 별도 src 설정.
        const poster = el.dataset.lazyPoster;
        if (poster) { el.poster = poster; delete el.dataset.lazyPoster; }
        const src = el.dataset.lazySrc;   // 하위 호환 — 옛 카드가 src 만 쓰는 경우
        if (src) { el.src = src; delete el.dataset.lazySrc; }
        return;
    }
}

/** 단일 element 를 lazy 등록. */
export function lazyAttach(el) {
    if (!el || !el.dataset) return;
    if (!el.dataset.lazySrc && !el.dataset.lazyPoster) return;
    if (el.tagName !== "IMG" && el.tagName !== "VIDEO") return;
    _getIO().observe(el);
}

/** parent 아래의 모든 lazy 후보를 일괄 등록. */
export function lazyScan(parent) {
    if (!parent) return;
    const list = parent.querySelectorAll(
        "img[data-lazy-src], video[data-lazy-src], video[data-lazy-poster]"
    );
    const io = _getIO();
    list.forEach((el) => io.observe(el));
}

// 하위 호환 — 이전 video 전용 API alias.
export const lazyAttachVideo = lazyAttach;
