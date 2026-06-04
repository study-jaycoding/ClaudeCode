// =====================================================================
// 비디오 카드 lazy 로드 + IndexedDB poster 캐시.
//
// <video> 는 HTML5 표준 loading="lazy" 가 없어 viewport 밖에서도 preload 가
// 즉시 동작 — 폴더에 비디오 30개면 30개 metadata 요청이 동시 발사.
//
// 두 단계 절감:
//   1) IntersectionObserver (rootMargin=200px) — viewport 진입 시에만 처리
//   2) IndexedDB poster 캐시 — 한 번 캡쳐한 첫 프레임 JPG 를 저장,
//      이후엔 비디오 src 를 안 설정하고 poster 만 박음. metadata 요청 0,
//      디코드 0, 브라우저는 단일 작은 이미지로 표시.
//
// 사용법:
//   <video data-lazy-src="..." preload="none" muted></video>
//   ↓ DOM 삽입 후
//   lazyAttachVideo(el)   // 또는 lazyScan(parent) 로 일괄
// =====================================================================

const ROOT_MARGIN = "200px";
const THRESHOLD = 0.01;

const DB_NAME = "pv-thumbs";
const DB_VERSION = 1;
const STORE_POSTERS = "video-posters";

// 캡쳐 thumbnail 의 긴 변 최대 px. grid 카드가 보통 200-300px 이라 400 이면 충분.
const POSTER_MAX_DIM = 400;
const POSTER_JPEG_Q = 0.75;

// ── IndexedDB ────────────────────────────────────────────────────────
let _dbPromise = null;
function _openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        try {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_POSTERS)) {
                    db.createObjectStore(STORE_POSTERS);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        } catch (e) {
            reject(e);
        }
    });
    // 한 번 실패해도 다음에 다시 시도 못 하면 영구 실패 — 안전망으로 catch 후 null cache
    _dbPromise.catch(() => { _dbPromise = null; });
    return _dbPromise;
}

async function _getPoster(key) {
    try {
        const db = await _openDB();
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_POSTERS, "readonly");
            const req = tx.objectStore(STORE_POSTERS).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch { return null; }
}

async function _putPoster(key, blob) {
    try {
        const db = await _openDB();
        await new Promise((resolve) => {
            const tx = db.transaction(STORE_POSTERS, "readwrite");
            tx.objectStore(STORE_POSTERS).put(blob, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
    } catch {}
}

// ── 첫 프레임 캡쳐 ───────────────────────────────────────────────────
function _captureFirstFrame(videoEl) {
    return new Promise((resolve) => {
        const tryCapture = () => {
            try {
                const w = videoEl.videoWidth;
                const h = videoEl.videoHeight;
                if (!w || !h) { resolve(null); return; }
                const scale = Math.min(1, POSTER_MAX_DIM / Math.max(w, h));
                const tw = Math.max(1, Math.round(w * scale));
                const th = Math.max(1, Math.round(h * scale));
                const canvas = document.createElement("canvas");
                canvas.width = tw;
                canvas.height = th;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(videoEl, 0, 0, tw, th);
                canvas.toBlob((blob) => resolve(blob), "image/jpeg", POSTER_JPEG_Q);
            } catch { resolve(null); }
        };
        // readyState >= 2 (HAVE_CURRENT_DATA) 면 프레임 픽셀 데이터 사용 가능
        if (videoEl.readyState >= 2) tryCapture();
        else videoEl.addEventListener("loadeddata", tryCapture, { once: true });
        // 안전 timeout — 어떤 이유로 loadeddata 안 오면 null
        setTimeout(() => resolve(null), 10_000);
    });
}

// ── IntersectionObserver ─────────────────────────────────────────────
let _io = null;
function _getIO() {
    if (_io) return _io;
    _io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            _io.unobserve(e.target);
            _handleEnter(e.target);
        }
    }, { rootMargin: ROOT_MARGIN, threshold: THRESHOLD });
    return _io;
}

async function _handleEnter(v) {
    const src = v.dataset.lazySrc;
    if (!src) return;
    delete v.dataset.lazySrc;

    // 캐시 hit — poster 만 박고 video src 는 건드리지 않음 (디코드 0)
    const cached = await _getPoster(src);
    if (cached && v.isConnected) {
        try {
            v.poster = URL.createObjectURL(cached);
            v.preload = "none";
            return;
        } catch {}
    }

    // 캐시 miss — 원본 1회 로드, 첫 프레임 캡쳐 후 저장
    if (!v.isConnected) return;
    v.preload = "metadata";
    v.src = src;
    const blob = await _captureFirstFrame(v);
    if (blob) {
        _putPoster(src, blob);
        // 캡쳐 후엔 video src 를 떼고 poster 만 둠 — 디코드 메모리 회수.
        // (재생이 필요한 경우는 stage/lightbox 가 별도로 src 를 set 함.)
        try {
            v.poster = URL.createObjectURL(blob);
            v.removeAttribute("src");
            v.load();
            v.preload = "none";
        } catch {}
    }
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
