// =====================================================================
// 정보 팝업 (좌클릭 long-press) + 카드 long-press 핸들러
// - cp-link click / contextmenu 는 contextPopup 단에서 delegation 으로 한 번만 등록
// - 외부 click / Esc 로 닫기
// 외부 의존: openTreeMenu (menus 모듈, callback)
// =====================================================================
import { contextPopup } from "./dom.js";
import { escapeHtml, humanSize, kindFromPath } from "./utils.js";
import { favorites, longPressTimer, setLongPressTimer } from "./state.js";
import { getFavorite } from "./favorites.js";
import { apiGetMeta } from "./api.js";
import { openLightbox } from "./lightbox.js";

let _openTreeMenu = () => {};
export function setOpenTreeMenuForPopupCallback(fn) {
    _openTreeMenu = typeof fn === "function" ? fn : () => {};
}

// 현재 팝업의 프롬프트 텍스트 (복사 버튼 대상). 팝업 하나만 떠 있으므로 모듈 단일.
let _currentPrompt = "";

// --- 카드 long-press 타이머 ---
const LONG_PRESS_MS = 350;
const LONG_PRESS_MOVE_TOL = 6;

function cancelLongPress() {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        setLongPressTimer(null);
    }
}

/** 카드 mousedown 에 long-press → showContextPopup 핸들러 부착. */
export function attachLongPress(card, project, node) {
    let startX = 0, startY = 0;
    card.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest(".card-marker")) return;
        if (node.type === "dir") return;
        if (e.shiftKey || e.ctrlKey || e.metaKey) return;
        startX = e.clientX; startY = e.clientY;
        const mx = e.clientX, my = e.clientY;
        cancelLongPress();
        setLongPressTimer(setTimeout(() => {
            setLongPressTimer(null);
            showContextPopup(mx, my, project, node);
        }, LONG_PRESS_MS));
    });
    card.addEventListener("mousemove", (e) => {
        if (!longPressTimer) return;
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > LONG_PRESS_MOVE_TOL) {
            cancelLongPress();
        }
    });
    card.addEventListener("mouseup", cancelLongPress);
    card.addEventListener("mouseleave", cancelLongPress);
    card.addEventListener("dragstart", cancelLongPress);
}

// --- 정보 팝업 ---
export function closeContextPopup() {
    contextPopup.classList.add("hidden");
    contextPopup.innerHTML = "";
}

/** @name 마커를 favorites 매칭해서 인라인 썸네일로, 나머지는 텍스트로 변환. */
function renderPromptWithThumbs(text) {
    let html = "";
    let i = 0;
    while (i < text.length) {
        const at = text.indexOf("@", i);
        if (at < 0) { html += escapeHtml(text.slice(i)); break; }
        if (at > i) html += escapeHtml(text.slice(i, at));
        const rest = text.slice(at + 1);
        // favName(파일명에서 확장자 제거) 으로 매칭. 긴 이름 우선.
        const candidates = favorites.map((f) => {
            const full = (f.path || "").split("/").pop() || "";
            const dot = full.lastIndexOf(".");
            const n = dot > 0 ? full.substring(0, dot) : full;
            return { fav: f, name: n };
        }).filter((c) => c.name && rest.startsWith(c.name));
        candidates.sort((a, b) => b.name.length - a.name.length);
        const hit = candidates.find((c) => {
            const ch = rest.charAt(c.name.length);
            return ch === "" || /[\s.,;:!?@()\[\]{}]/.test(ch);
        });
        if (hit) {
            const url = `/media?project=${encodeURIComponent(hit.fav.project)}&path=${encodeURIComponent(hit.fav.path)}`;
            html += `<span class="cp-prompt-ref" title="${escapeHtml(hit.name)}">`
                + `<img src="${url}" alt="" loading="lazy" />`
                + `</span>`;
            i = at + 1 + hit.name.length;
        } else {
            html += "@";
            i = at + 1;
        }
    }
    return html;
}

/** cp-link (소스/파생 행) 의 썸네일 + 이름 형태 HTML. */
function cpLinkThumbHtml(target, prefix) {
    const url = `/media?project=${encodeURIComponent(target.project)}&path=${encodeURIComponent(target.path)}`;
    const kind = kindFromPath(target.path);
    let thumbInner;
    if (kind === "image") {
        thumbInner = `<img src="${url}" alt="" loading="lazy" draggable="false" />`;
    } else if (kind === "video") {
        thumbInner = `<video src="${url}" preload="metadata" muted></video>`;
    } else {
        thumbInner = `<span class="cp-link-icon">📄</span>`;
    }
    const name = target.path.split("/").pop();
    return `<span class="cp-link cp-link-thumb" data-id="${escapeHtml(target.id)}" title="${escapeHtml(name)}">`
         + `<span class="cp-link-thumb-box">${thumbInner}</span>`
         + `<span class="cp-link-name">${prefix} ${escapeHtml(name)}</span>`
         + `</span>`;
}

export async function showContextPopup(mx, my, project, node) {
    const mediaUrl = `/media?project=${encodeURIComponent(project)}&path=${encodeURIComponent(node.path)}`;
    const fav = getFavorite(project, node.path);

    contextPopup.innerHTML = `<div class="cp-loading">불러오는 중...</div>`;
    contextPopup.classList.remove("hidden");
    positionPopup(mx, my);

    let meta = {};
    try { meta = await apiGetMeta(project, node.path); } catch {}

    let thumbHtml = "";
    if (node.kind === "image") {
        thumbHtml = `<div class="cp-thumb"><img src="${mediaUrl}" alt="" /></div>`;
    } else if (node.kind === "video") {
        thumbHtml = `<div class="cp-thumb"><video src="${mediaUrl}" preload="metadata" muted></video></div>`;
    }

    // 섹션별로 행 모아놓고 마지막에 헤더와 함께 조립.
    const fileRows = [];
    const sourceRows = [];
    const genRows = [];

    // ── 파일 정보 ──
    fileRows.push(`<tr><th>파일명</th><td>${escapeHtml(meta.name || node.name)}</td></tr>`);
    fileRows.push(`<tr><th>경로</th><td>${escapeHtml(node.path)}</td></tr>`);
    fileRows.push(`<tr><th>크기</th><td>${humanSize(meta.size || node.size)}</td></tr>`);
    fileRows.push(`<tr><th>형식</th><td>${escapeHtml((meta.ext || "").replace(".", "").toUpperCase() || node.kind)}</td></tr>`);
    if (meta.width && meta.height) {
        fileRows.push(`<tr><th>해상도</th><td>${meta.width} × ${meta.height} px</td></tr>`);
    }
    if (meta.ctime) fileRows.push(`<tr><th>생성일</th><td>${escapeHtml(meta.ctime)}</td></tr>`);
    if (meta.mtime) fileRows.push(`<tr><th>수정일</th><td>${escapeHtml(meta.mtime)}</td></tr>`);

    // ── 소스 정보 ──
    if (fav) {
        sourceRows.push(`<tr><th>ID</th><td><code>${escapeHtml(fav.id)}</code></td></tr>`);
        const tagHtml = fav.tags.length
            ? fav.tags.map((t) => `<span class="tag-chip small">#${escapeHtml(t)}</span>`).join(" ")
            : "<em style='color:#9aa1b3'>없음</em>";
        sourceRows.push(`<tr><th>태그</th><td>${tagHtml}</td></tr>`);

        if (fav.sourceIds && fav.sourceIds.length > 0) {
            const srcLinks = fav.sourceIds.map((sid) => {
                const src = favorites.find((f) => f.id === sid);
                return src ? cpLinkThumbHtml(src, "🔗") : `<code>${escapeHtml(sid)}</code>`;
            }).join("");
            sourceRows.push(`<tr><th>소스</th><td>${srcLinks}</td></tr>`);
        }

        const derived = favorites.filter((f) => (f.sourceIds || []).includes(fav.id));
        if (derived.length > 0) {
            const drvLinks = derived.map((d) => cpLinkThumbHtml(d, "→")).join("");
            sourceRows.push(`<tr><th>파생</th><td>${drvLinks}</td></tr>`);
        }
    } else {
        sourceRows.push(`<tr><th>등록</th><td><em style="color:#9aa1b3">미등록 (업로드되지 않은 파일)</em></td></tr>`);
    }

    // ── 생성 정보 (sidecar JSON) ──
    if (meta.sidecar) {
        const sc = meta.sidecar;
        const fmt = (v) => typeof v === "number"
            ? (Number.isInteger(v) ? String(v) : v.toFixed(2))
            : String(v ?? "");
        if (sc.model) genRows.push(`<tr><th>모델</th><td>${escapeHtml(fmt(sc.model))}</td></tr>`);
        if (sc.aspect_ratio) genRows.push(`<tr><th>비율</th><td>${escapeHtml(fmt(sc.aspect_ratio))}</td></tr>`);
        const optKeys = ["resolution", "quality", "mode", "duration", "sound", "genre",
                         "flux_variant", "veo_variant", "minimax_variant"];
        const optParts = optKeys.filter((k) => sc[k] != null && sc[k] !== "")
            .map((k) => `<span class="tag-chip small">${escapeHtml(k)}: ${escapeHtml(fmt(sc[k]))}</span>`);
        if (optParts.length) genRows.push(`<tr><th>옵션</th><td>${optParts.join(" ")}</td></tr>`);
        if (sc.credits != null) {
            const per = sc.credits_per_job != null && sc.job_ids && sc.job_ids.length > 1
                ? ` <span style="color:#9aa1b3">(${fmt(sc.credits_per_job)} × ${sc.job_ids.length})</span>`
                : "";
            genRows.push(`<tr><th>크레딧</th><td>✦ ${fmt(sc.credits)}${per}</td></tr>`);
        }
        if (sc.creator) genRows.push(`<tr><th>생성자</th><td>${escapeHtml(fmt(sc.creator))}</td></tr>`);
        const shownPrompt = sc.display_prompt || sc.prompt;
        if (shownPrompt) {
            const promptHtml = renderPromptWithThumbs(shownPrompt);
            genRows.push(`<tr><th>프롬프트</th><td>
                <div class="cp-prompt cp-prompt-copy" title="클릭해서 복사">${promptHtml}</div>
            </td></tr>`);
        }
        // 외부 ref (즐겨찾기로 추적되지 않는 URL) 만 별도 노출 — favorites 의 소스 행과 중복 회피
        const srcIdSet = new Set(Array.isArray(sc.source_ids) ? sc.source_ids : []);
        const refUrls = Array.isArray(sc.ref_urls) ? sc.ref_urls : [];
        const favUrlSet = new Set();
        for (const sid of srcIdSet) {
            const src = favorites.find((f) => f.id === sid);
            if (src) favUrlSet.add(`/media?project=${encodeURIComponent(src.project)}&path=${encodeURIComponent(src.path)}`);
        }
        const extraRefs = refUrls.filter((u) => !favUrlSet.has(u));
        if (extraRefs.length) {
            const parts = extraRefs.map((u) => {
                const isImg = /\.(png|jpe?g|gif|webp|svg|bmp)(\?|$)/i.test(u);
                const thumb = isImg
                    ? `<span class="cp-link-thumb-box"><img src="${escapeHtml(u)}" alt="" loading="lazy" /></span>`
                    : `<span class="cp-link-thumb-box"><span class="cp-link-icon">🌐</span></span>`;
                return `<span class="cp-link cp-link-thumb" title="${escapeHtml(u)}">`
                    + thumb
                    + `<span class="cp-link-name">${escapeHtml(u.split("/").pop() || u)}</span>`
                    + `</span>`;
            }).join("");
            genRows.push(`<tr><th>외부 ref</th><td>${parts}</td></tr>`);
        }
        if (Array.isArray(sc.job_ids) && sc.job_ids.length) {
            const jids = sc.job_ids.map((j) => `<code>${escapeHtml(j)}</code>`).join(" ");
            genRows.push(`<tr><th>Job ID</th><td>${jids}</td></tr>`);
        }
        _currentPrompt = sc.display_prompt || sc.prompt || "";
    } else {
        _currentPrompt = "";
    }

    // 섹션 헤더 + rows 조립
    const section = (title, rs) => rs.length
        ? `<tr class="cp-section"><th colspan="2">${title}</th></tr>${rs.join("")}`
        : "";
    const tableHtml = section("파일 정보", fileRows)
        + section("소스 정보", sourceRows)
        + section("생성 정보", genRows);

    contextPopup.innerHTML = `
        ${thumbHtml}
        <table class="cp-table">${tableHtml}</table>`;
    positionPopup(mx, my);
}

function positionPopup(mx, my) {
    contextPopup.style.left = "0px";
    contextPopup.style.top = "0px";
    const rect = contextPopup.getBoundingClientRect();
    const pw = rect.width, ph = rect.height;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = mx + 4, y = my + 4;
    if (x + pw > vw - 8) x = mx - pw - 4;
    if (y + ph > vh - 8) y = vh - ph - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    contextPopup.style.left = x + "px";
    contextPopup.style.top = y + "px";
}

// --- cp-link delegation (한 번만 등록) ---
contextPopup.addEventListener("click", (e) => {
    // 프롬프트 텍스트 클릭 → 복사
    const promptEl = e.target.closest(".cp-prompt-copy");
    if (promptEl) {
        e.stopPropagation();
        const text = _currentPrompt;
        const flash = (msg, cls) => {
            const badge = document.createElement("span");
            badge.className = "cp-copied-badge " + (cls || "");
            badge.textContent = msg;
            promptEl.appendChild(badge);
            setTimeout(() => badge.remove(), 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => flash("✓ 복사됨"))
                .catch(() => flash("⚠ 실패", "err"));
        } else {
            try {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.style.position = "fixed"; ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select(); document.execCommand("copy");
                document.body.removeChild(ta);
                flash("✓ 복사됨");
            } catch { flash("⚠ 실패", "err"); }
        }
        return;
    }
    const link = e.target.closest(".cp-link");
    if (!link) return;
    e.stopPropagation();
    const target = favorites.find((f) => f.id === link.dataset.id);
    if (!target) return;
    const k = kindFromPath(target.path);
    closeContextPopup();
    openLightbox(target.project, { name: target.path.split("/").pop(), path: target.path, kind: k, size: 0 });
});

contextPopup.addEventListener("contextmenu", (e) => {
    // 정보 팝업 안의 우클릭 — 브라우저 기본 메뉴 항상 차단
    e.preventDefault();
    e.stopPropagation();
    const link = e.target.closest(".cp-link");
    if (!link) return;
    const target = favorites.find((f) => f.id === link.dataset.id);
    if (!target) return;
    _openTreeMenu(e.clientX, e.clientY, target.project, [target.path], {
        actions: ["navigate", "reveal"],
    });
});

// --- 외부 click / Esc 로 닫기 ---
document.addEventListener("click", (e) => {
    if (contextPopup.classList.contains("hidden")) return;
    if (contextPopup.contains(e.target)) return;
    // 카드 위 click 은 카드 핸들러가 새 팝업으로 갱신하므로 여기서 닫지 않음
    if (e.target.closest(".card")) return;
    closeContextPopup();
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !contextPopup.classList.contains("hidden")) {
        closeContextPopup();
    }
});
