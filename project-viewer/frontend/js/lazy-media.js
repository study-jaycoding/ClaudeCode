// =====================================================================
// 비디오 + 이미지 카드 lazy 로드 + IndexedDB 썸네일 캐시.
//
// 진짜 비용은 transfer 가 아니라 *디코드*. localhost 라 바이트는 거의 무료지만
// 28MB PNG 한 장의 디코드 = 100MB RGBA + 수십 ms CPU. 그리드에 10장이면 합산해
// 큰 stall. 한 번만 캡쳐해서 작은 JPG 썸네일을 IndexedDB 에 저장 → 이후 진입
// 부터는 작은 썸네일만 디코드.
//
// 두 단계 절감:
//   1) IntersectionObserver (rootMargin=200px) — viewport 진입 시에만 처리
//   2) IndexedDB 썸네일 캐시:
//      - video: 첫 프레임 JPG 를 poster 로 박음. src 안 설정 → 디코드 0
//      - image: 두 번째 진입부터 작은 JPG 로 swap → 디코드 ~100배 감소
//
// 사용법:
//   <video data-lazy-src="..." preload="none" muted></video>
//   <img   data-lazy-src="..." loading="lazy" alt="" />
//   ↓ DOM 삽입 후
//   lazyScan(parent)   // 단일은 lazyAttach(el)
// =====================================================================

const ROOT_MARGIN = "200px";
const THRESHOLD = 0.01;

const DB_NAME = "pv-thumbs";
const DB_VERSION = 2;                    // v1 → v2: image-thumbs store 추가
const STORE_POSTERS = "video-posters";   // video 첫 프레임
const STORE_IMG_THUMBS = "image-thumbs"; // 원본 이미지 downscale

// 캡쳐 thumbnail 의 긴 변 최대 px. 카드 100-320px + retina 2x 까지 커버 800.
const THUMB_MAX_DIM = 800;
const THUMB_JPEG_Q = 0.8;

// downscale 의미 없는 작은 이미지는 skip (원본 그대로). 800px 미만이면 downscale = no-op.
const MIN_DOWNSCALE_DIM = THUMB_MAX_DIM;

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
                if (!db.objectStoreNames.contains(STORE_IMG_THUMBS)) {
                    db.createObjectStore(STORE_IMG_THUMBS);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        } catch (e) {
            reject(e);
        }
    });
    _dbPromise.catch(() => { _dbPromise = null; });
    return _dbPromise;
}

async function _idbGet(store, key) {
    try {
        const db = await _openDB();
        return await new Promise((resolve) => {
            const tx = db.transaction(store, "readonly");
            const req = tx.objectStore(store).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch { return null; }
}

async function _idbPut(store, key, blob) {
    try {
        const db = await _openDB();
        await new Promise((resolve) => {
            const tx = db.transaction(store, "readwrite");
            tx.objectStore(store).put(blob, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
    } catch {}
}

// ── 캡쳐 helpers ────────────────────────────────────────────────────
function _downscaleToBlob(srcEl, w, h) {
    return new Promise((resolve) => {
        try {
            if (!w || !h) { resolve(null); return; }
            const scale = Math.min(1, THUMB_MAX_DIM / Math.max(w, h));
            const tw = Math.max(1, Math.round(w * scale));
            const th = Math.max(1, Math.round(h * scale));
            const canvas = document.createElement("canvas");
            canvas.width = tw;
            canvas.height = th;
            canvas.getContext("2d").drawImage(srcEl, 0, 0, tw, th);
            canvas.toBlob((blob) => resolve(blob), "image/jpeg", THUMB_JPEG_Q);
        } catch { resolve(null); }
    });
}

function _captureFirstVideoFrame(videoEl) {
    return new Promise((resolve) => {
        const tryCapture = async () => {
            const blob = await _downscaleToBlob(videoEl, videoEl.videoWidth, videoEl.videoHeight);
            resolve(blob);
        };
        if (videoEl.readyState >= 2) tryCapture();
        else videoEl.addEventListener("loadeddata", tryCapture, { once: true });
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

async function _handleEnter(el) {
    if (el.tagName === "VIDEO") return _handleVideoEnter(el);
    if (el.tagName === "IMG")   return _handleImageEnter(el);
}

async function _handleVideoEnter(v) {
    const src = v.dataset.lazySrc;
    if (!src) return;
    delete v.dataset.lazySrc;

    // 캐시 hit — poster 만 박고 video src 는 건드리지 않음 (디코드 0)
    const cached = await _idbGet(STORE_POSTERS, src);
    if (cached && v.isConnected) {
        try {
            v.poster = URL.createObjectURL(cached);
            v.preload = "none";
            return;
        } catch {}
    }

    // miss — 원본 1회 로드, 첫 프레임 캡쳐 후 저장
    if (!v.isConnected) return;
    v.preload = "metadata";
    v.src = src;
    const blob = await _captureFirstVideoFrame(v);
    if (blob) {
        _idbPut(STORE_POSTERS, src, blob);
        try {
            v.poster = URL.createObjectURL(blob);
            v.removeAttribute("src");
            v.load();
            v.preload = "none";
        } catch {}
    }
}

async function _handleImageEnter(img) {
    const src = img.dataset.lazySrc;
    if (!src) return;
    delete img.dataset.lazySrc;

    // 캐시 hit — 작은 썸네일 표시. 원본 디코드 0.
    const cached = await _idbGet(STORE_IMG_THUMBS, src);
    if (cached && img.isConnected) {
        try {
            img.src = URL.createObjectURL(cached);
            return;
        } catch {}
    }

    // miss — 원본 한 번 로드해서 그대로 표시 (사용자에겐 지금과 같은 체감).
    // 백그라운드에서 downscale → cache → 작은 blob 으로 swap (큰 디코드 메모리 회수).
    if (!img.isConnected) return;
    img.src = src;
    img.addEventListener("load", async () => {
        const nw = img.naturalWidth, nh = img.naturalHeight;
        if (!nw || !nh) return;
        // 이미 작은 이미지는 downscale 의미 없음 — 캐시하지 않음
        if (Math.max(nw, nh) < MIN_DOWNSCALE_DIM) return;
        const blob = await _downscaleToBlob(img, nw, nh);
        if (!blob) return;
        _idbPut(STORE_IMG_THUMBS, src, blob);
        if (img.isConnected) {
            try { img.src = URL.createObjectURL(blob); } catch {}
        }
    }, { once: true });
}

/** 단일 element (video 또는 img) 를 lazy 등록. data-lazy-src 가 있을 때만 동작. */
export function lazyAttach(el) {
    if (!el || !el.dataset || !el.dataset.lazySrc) return;
    if (el.tagName !== "VIDEO" && el.tagName !== "IMG") return;
    _getIO().observe(el);
}

/** parent 아래의 모든 data-lazy-src 비디오/이미지를 일괄 등록. */
export function lazyScan(parent) {
    if (!parent) return;
    const list = parent.querySelectorAll("video[data-lazy-src], img[data-lazy-src]");
    const io = _getIO();
    list.forEach((el) => io.observe(el));
}

/** 하위 호환 — 기존 video 전용 export 도 유지. */
export const lazyAttachVideo = lazyAttach;
