// =====================================================================
// IntersectionObserver 기반 비디오 lazy 로드.
//
// <video> 는 HTML5 표준 loading="lazy" 가 없어 viewport 밖에서도 preload 가
// 즉시 동작 — 폴더에 비디오 30개면 30개 metadata 요청이 동시 발사된다.
//
// 사용법:
//   <video data-lazy-src="..." preload="none" muted></video>
//   ↓ DOM 삽입 후
//   lazyAttachVideo(el)   // 또는 lazyScan(parent) 로 일괄
//
// viewport 200px 안에 들어오면 src 를 설정하고 preload 를 "metadata" 로 승격.
// 그 후 IO 에서 unobserve — 다시는 안 봄.
// =====================================================================

const ROOT_MARGIN = "200px";
const THRESHOLD = 0.01;

let _io = null;
function _getIO() {
    if (_io) return _io;
    _io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            const v = e.target;
            const src = v.dataset.lazySrc;
            if (src && !v.src) {
                v.preload = "metadata";
                v.src = src;
                delete v.dataset.lazySrc;
            }
            _io.unobserve(v);
        }
    }, { rootMargin: ROOT_MARGIN, threshold: THRESHOLD });
    return _io;
}

/** 단일 video element 를 lazy 등록. data-lazy-src 가 있을 때만 동작. */
export function lazyAttachVideo(el) {
    if (!el || el.tagName !== "VIDEO") return;
    if (!el.dataset.lazySrc) return;
    _getIO().observe(el);
}

/** parent 아래의 모든 data-lazy-src 비디오를 일괄 등록. */
export function lazyScan(parent) {
    if (!parent) return;
    const list = parent.querySelectorAll("video[data-lazy-src]");
    const io = _getIO();
    list.forEach((v) => io.observe(v));
}
