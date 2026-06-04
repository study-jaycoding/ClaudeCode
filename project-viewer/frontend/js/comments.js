// =====================================================================
// 코멘트 — 파일별 코멘트 (팀 협업용)
// - 백엔드의 _meta/comments.json 에 영구 저장
// - 누구나 추가/조회 가능 (author 는 localStorage 의 viewer.commentAuthor 사용)
// - 카드 우하단에 C 배지로 표시, 클릭 시 모달 열림
// =====================================================================
import { currentProject } from "./state.js";
import {
    apiGetComments, apiAddComment, apiAddReply, apiDeleteComment, apiUpdateComment,
} from "./api.js";
import { escapeHtml } from "./utils.js";
import { showOk, showError } from "./info-toast.js";

const AUTHOR_KEY = "viewer.commentAuthor";
// 코멘트/답글 단위로 "본 것" 추적. id 가 set 에 있으면 viewed.
// localStorage: { "project|path": ["id1", "id2", ...] }
const VIEWED_IDS_KEY = "viewer.commentsViewedIds";

/** localStorage 의 user name. 없으면 prompt. 빈 입력은 거절. */
export function getCommentAuthor() {
    try {
        const v = localStorage.getItem(AUTHOR_KEY);
        if (v && v.trim()) return v.trim();
    } catch {}
    return "";
}
export function setCommentAuthor(name) {
    const v = (name || "").trim().substring(0, 80);
    try {
        if (v) localStorage.setItem(AUTHOR_KEY, v);
        else localStorage.removeItem(AUTHOR_KEY);
    } catch {}
}
/** 코멘트 추가 전에 author 가 없으면 prompt 로 받음. 취소 시 null. */
function ensureAuthor() {
    let a = getCommentAuthor();
    if (a) return a;
    const v = prompt("코멘트를 남기려면 표시할 이름을 입력하세요 (팀원이 보게 됩니다)", "");
    if (v === null) return null;
    const trimmed = v.trim();
    if (!trimmed) return null;
    setCommentAuthor(trimmed);
    return trimmed;
}

// ── 캐시 ──
// _comments[path] = [comment, ...]   (현재 프로젝트만)
let _comments = {};

/** path 의 코멘트 배열 (없으면 []). */
export function getCommentsFor(path) {
    return _comments[path] || [];
}

// path 가 정확히 일치하는 파일 OR path 의 자손 (path/...) 의 코멘트 합산 헬퍼.
// 폴더 카드에서 호출되면 그 안의 모든 파일 코멘트가 합산됨.
function _matchKeys(path) {
    if (!path) return [];
    const prefix = path + "/";
    return Object.keys(_comments).filter((k) => k === path || k.startsWith(prefix));
}

/** path 가 코멘트가 있는지 (= C 배지 표시 여부).
 *  파일이면 자기 자신, 폴더면 자손 어딘가에. */
export function hasComments(path) {
    if (!path) return false;
    for (const k of _matchKeys(path)) {
        if (_comments[k] && _comments[k].length > 0) return true;
    }
    return false;
}

/** 카운트 (배지 숫자 용) — 본 코멘트 + 답글. 폴더면 자손 모두 합산. */
export function commentCount(path) {
    if (!path) return 0;
    let n = 0;
    for (const k of _matchKeys(path)) {
        for (const c of (_comments[k] || [])) {
            n += 1;
            if (Array.isArray(c.replies)) n += c.replies.length;
        }
    }
    return n;
}

// ── viewed 추적 (per-comment ID) ──
function _viewedKey(path) {
    return `${currentProject || ""}|${path || ""}`;
}
function _readViewedMap() {
    try { return JSON.parse(localStorage.getItem(VIEWED_IDS_KEY) || "{}") || {}; }
    catch { return {}; }
}
function _writeViewedMap(m) {
    try { localStorage.setItem(VIEWED_IDS_KEY, JSON.stringify(m)); } catch {}
}

/** path 의 본 코멘트/답글 id Set. */
function _viewedIdSet(path) {
    const arr = _readViewedMap()[_viewedKey(path)];
    return new Set(Array.isArray(arr) ? arr : []);
}

/** path 의 특정 id 를 본 것으로 추가 (이미 있으면 noop). */
export function markCommentViewedById(path, id) {
    if (!path || !id) return;
    const m = _readViewedMap();
    const key = _viewedKey(path);
    const arr = Array.isArray(m[key]) ? m[key] : [];
    if (arr.includes(id)) return;
    arr.push(id);
    m[key] = arr;
    _writeViewedMap(m);
    _notifyChanged();
}

/** path 의 모든 코멘트 id 를 본 것으로 표시 (모두 읽음 버튼 용). */
export function markAllCommentsViewed(path) {
    if (!path) return;
    const arr = _comments[path] || [];
    const ids = [];
    for (const c of arr) {
        ids.push(c.id);
        if (Array.isArray(c.replies)) for (const r of c.replies) ids.push(r.id);
    }
    const m = _readViewedMap();
    m[_viewedKey(path)] = ids;
    _writeViewedMap(m);
    _notifyChanged();
}

/** path 의 코멘트 + 답글 중 안 본 항목 수. 폴더면 자손 모두 합산.
 *  viewedIds 는 파일별로 관리되므로 자손 파일마다 따로 조회. */
export function unseenCommentCount(path) {
    if (!path) return 0;
    let n = 0;
    for (const k of _matchKeys(path)) {
        const arr = _comments[k] || [];
        if (arr.length === 0) continue;
        const viewed = _viewedIdSet(k);
        for (const c of arr) {
            if (!viewed.has(c.id)) n++;
            if (Array.isArray(c.replies)) {
                for (const r of c.replies) if (!viewed.has(r.id)) n++;
            }
        }
    }
    return n;
}

/** 특정 id 가 아직 안 본 상태인지 (NEW 표시 용). */
function _isUnseenId(path, id) {
    return !_viewedIdSet(path).has(id);
}

/** 백엔드에서 현재 프로젝트 코멘트 로드. */
export async function loadComments() {
    if (!currentProject) {
        _comments = {};
        _notifyChanged();
        return;
    }
    try {
        const data = await apiGetComments(currentProject);
        _comments = (data && data.comments) || {};
    } catch {
        _comments = {};
    }
    _notifyChanged();
}

function _notifyChanged() {
    try { window.dispatchEvent(new CustomEvent("pv:comments-changed")); } catch {}
}

/** 신규 코멘트 추가. 성공 시 true. */
async function addCommentInternal(path, text) {
    const author = ensureAuthor();
    if (!author) return false;
    if (!currentProject || !path || !text.trim()) return false;
    const res = await apiAddComment(currentProject, path, author, text);
    if (!res || !res.ok || !res.comment) {
        showError("코멘트 추가 실패: " + (res?.error || "unknown"));
        return false;
    }
    (_comments[path] = _comments[path] || []).push(res.comment);
    _notifyChanged();
    return true;
}

async function deleteCommentInternal(path, id) {
    if (!currentProject || !path || !id) return false;
    const res = await apiDeleteComment(currentProject, path, id);
    if (!res || !res.ok) return false;
    const arr = _comments[path] || [];
    _comments[path] = arr.filter((c) => c.id !== id);
    if (_comments[path].length === 0) delete _comments[path];
    _notifyChanged();
    return true;
}

async function updateCommentInternal(path, id, text) {
    if (!currentProject || !path || !id || !text.trim()) return false;
    const res = await apiUpdateComment(currentProject, path, id, text);
    if (!res || !res.ok) {
        showError("코멘트 수정 실패");
        return false;
    }
    const arr = _comments[path] || [];
    for (const c of arr) {
        if (c.id === id) { c.text = text; c.editedAt = Date.now(); break; }
        for (const r of (c.replies || [])) {
            if (r.id === id) { r.text = text; r.editedAt = Date.now(); break; }
        }
    }
    _notifyChanged();
    return true;
}

async function addReplyInternal(path, parentId, text) {
    const author = ensureAuthor();
    if (!author) return false;
    if (!currentProject || !path || !parentId || !text.trim()) return false;
    const res = await apiAddReply(currentProject, path, parentId, author, text);
    if (!res || !res.ok || !res.reply) {
        showError("답글 추가 실패: " + (res?.error || "unknown"));
        return false;
    }
    const arr = _comments[path] || [];
    for (const c of arr) {
        if (c.id === parentId) {
            if (!Array.isArray(c.replies)) c.replies = [];
            c.replies.push(res.reply);
            break;
        }
    }
    _notifyChanged();
    return true;
}

// ── Modal UI ──
let _modalEl = null;
let _modalPath = "";

function _fmtTime(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function _ensureModal() {
    if (_modalEl) return _modalEl;
    _modalEl = document.createElement("div");
    _modalEl.id = "comments-modal";
    _modalEl.className = "comments-modal hidden";
    _modalEl.innerHTML = `
        <div class="cm-box">
            <div class="cm-header">
                <span class="cm-title">코멘트</span>
                <span class="cm-path" id="cm-path"></span>
                <button class="cm-mark-all" type="button" title="모든 새 코멘트를 본 것으로 표시">모두 읽음</button>
                <button class="cm-close" type="button" title="닫기 (Esc)">✕</button>
            </div>
            <div class="cm-list" id="cm-list"></div>
            <div class="cm-form">
                <div class="cm-form-row">
                    <label class="cm-author-label">이름:
                        <input class="cm-author-input" id="cm-author" type="text" placeholder="표시할 이름" maxlength="80" />
                    </label>
                    <span class="cm-hint">팀원 모두에게 보입니다</span>
                </div>
                <textarea class="cm-text" id="cm-text" rows="3" placeholder="코멘트를 입력하세요 — Ctrl+Enter 로 저장" maxlength="2000"></textarea>
                <div class="cm-form-actions">
                    <button class="cm-cancel" type="button">취소</button>
                    <button class="cm-submit" type="button">추가</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(_modalEl);

    const close = () => closeCommentsModal();
    _modalEl.querySelector(".cm-close").addEventListener("click", close);
    _modalEl.querySelector(".cm-cancel").addEventListener("click", close);
    _modalEl.addEventListener("click", (e) => { if (e.target === _modalEl) close(); });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !_modalEl.classList.contains("hidden")) close();
    });

    // 모두 읽음 — 현재 path 의 모든 코멘트 id 를 viewed 로
    _modalEl.querySelector(".cm-mark-all").addEventListener("click", () => {
        markAllCommentsViewed(_modalPath);
        _renderModalList();
    });

    const authorInput = _modalEl.querySelector("#cm-author");
    authorInput.addEventListener("change", () => setCommentAuthor(authorInput.value));

    const textArea = _modalEl.querySelector("#cm-text");
    textArea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            _submitFromForm();
        }
    });
    _modalEl.querySelector(".cm-submit").addEventListener("click", _submitFromForm);

    return _modalEl;
}

async function _submitFromForm() {
    const textArea = _modalEl.querySelector("#cm-text");
    const authorInput = _modalEl.querySelector("#cm-author");
    const submitBtn = _modalEl.querySelector(".cm-submit");
    const text = textArea.value.trim();
    if (!text) { textArea.focus(); return; }
    setCommentAuthor(authorInput.value);
    // 더블 클릭 방지
    if (submitBtn) submitBtn.disabled = true;
    try {
        const ok = await addCommentInternal(_modalPath, text);
        if (ok) {
            textArea.value = "";
            _renderModalList();
            showOk("코멘트 추가됨");
            // 추가 후 textarea 포커스 — 추가 코멘트 빠르게 입력
            textArea.focus();
        }
        // addCommentInternal 안에서 showError 가 이미 호출되므로 여기서 별도 처리 불필요
    } catch (e) {
        showError("코멘트 추가 중 오류: " + (e?.message || String(e)));
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

function _renderItemHtml(c, isReply, isMine, isNew) {
    const edited = c.editedAt ? ` (수정: ${_fmtTime(c.editedAt)})` : "";
    const replyBtn = isReply ? "" : `<button class="cm-reply-btn" type="button" title="답글">↩</button>`;
    const newBadge = isNew ? `<span class="cm-new-badge" title="클릭하면 읽음 처리">NEW</span>` : "";
    return `
        <div class="cm-item${isMine ? " is-mine" : ""}${isReply ? " is-reply" : ""}${isNew ? " is-new" : ""}" data-id="${escapeHtml(c.id)}">
            <div class="cm-item-head">
                <span class="cm-author">${escapeHtml(c.author || "익명")}</span>
                <span class="cm-time">${escapeHtml(_fmtTime(c.createdAt))}${escapeHtml(edited)}</span>
                ${newBadge}
                ${replyBtn}
                ${isMine ? `<button class="cm-edit" type="button" title="수정">✎</button>` : ""}
                ${isMine ? `<button class="cm-del" type="button" title="삭제">×</button>` : ""}
            </div>
            <div class="cm-text-body">${escapeHtml(c.text)}</div>
        </div>
    `;
}

function _renderModalList() {
    const list = _modalEl.querySelector("#cm-list");
    const rawArr = getCommentsFor(_modalPath);
    if (rawArr.length === 0) {
        list.innerHTML = `<div class="cm-empty">아직 코멘트가 없습니다 — 첫 코멘트를 남겨보세요</div>`;
        return;
    }
    const me = getCommentAuthor();
    const viewed = _viewedIdSet(_modalPath);
    // 최상위 코멘트 — 최신이 위로 (createdAt 내림차순). 답글은 thread 안에서 시간순 유지.
    const arr = [...rawArr].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    list.innerHTML = arr.map((c) => {
        const top = _renderItemHtml(c, false, c.author === me, !viewed.has(c.id));
        const replies = (Array.isArray(c.replies) ? c.replies : []).map(
            (r) => _renderItemHtml(r, true, r.author === me, !viewed.has(r.id))
        ).join("");
        const replyFormHtml = `
            <div class="cm-reply-form hidden" data-parent="${escapeHtml(c.id)}">
                <textarea class="cm-reply-text" rows="2" placeholder="답글 입력 — Ctrl+Enter 로 저장" maxlength="2000"></textarea>
                <div class="cm-reply-actions">
                    <button class="cm-reply-cancel" type="button">취소</button>
                    <button class="cm-reply-submit" type="button">답글</button>
                </div>
            </div>
        `;
        return `<div class="cm-thread" data-thread="${escapeHtml(c.id)}">
            ${top}
            <div class="cm-replies">${replies}</div>
            ${replyFormHtml}
        </div>`;
    }).join("");

    // NEW 아이템 클릭 (아이템 본문 또는 NEW 배지) = 그 id 만 viewed 처리.
    // 버튼들 (수정/삭제/답글) 클릭은 stopPropagation 안 해도 됨 — 그 동작 후 id 도 viewed 처리되는 게 자연스러움.
    list.querySelectorAll(".cm-item.is-new").forEach((el) => {
        el.addEventListener("click", (e) => {
            // 답글 폼 내부 등 자식 인터랙티브 element 는 제외 안 함 — 어떤 식으로든 클릭하면 본 것
            const id = el.dataset.id;
            markCommentViewedById(_modalPath, id);
            el.classList.remove("is-new");
            const badge = el.querySelector(".cm-new-badge");
            if (badge) badge.remove();
        });
    });

    // 이벤트 위임 — 삭제 / 수정 / 답글 열기 / 답글 제출
    list.querySelectorAll(".cm-del").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const id = btn.closest(".cm-item").dataset.id;
            if (!confirm("이 항목을 삭제할까요?")) return;
            await deleteCommentInternal(_modalPath, id);
            _renderModalList();
        });
    });
    list.querySelectorAll(".cm-edit").forEach((btn) => {
        btn.addEventListener("click", () => {
            const id = btn.closest(".cm-item").dataset.id;
            // 최상위 또는 답글 양쪽에서 찾기
            let cur = "";
            for (const c of getCommentsFor(_modalPath)) {
                if (c.id === id) { cur = c.text; break; }
                for (const r of (c.replies || [])) {
                    if (r.id === id) { cur = r.text; break; }
                }
                if (cur) break;
            }
            const next = prompt("내용 수정", cur);
            if (next === null) return;
            const trimmed = next.trim();
            if (!trimmed) return;
            updateCommentInternal(_modalPath, id, trimmed).then(() => _renderModalList());
        });
    });
    list.querySelectorAll(".cm-reply-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const threadEl = btn.closest(".cm-thread");
            const form = threadEl.querySelector(".cm-reply-form");
            form.classList.toggle("hidden");
            if (!form.classList.contains("hidden")) {
                form.querySelector(".cm-reply-text").focus();
            }
        });
    });
    list.querySelectorAll(".cm-reply-cancel").forEach((btn) => {
        btn.addEventListener("click", () => {
            const form = btn.closest(".cm-reply-form");
            form.classList.add("hidden");
            form.querySelector(".cm-reply-text").value = "";
        });
    });
    list.querySelectorAll(".cm-reply-submit").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const form = btn.closest(".cm-reply-form");
            const parentId = form.dataset.parent;
            const ta = form.querySelector(".cm-reply-text");
            const text = ta.value.trim();
            if (!text) { ta.focus(); return; }
            btn.disabled = true;
            try {
                const ok = await addReplyInternal(_modalPath, parentId, text);
                if (ok) {
                    showOk("답글 추가됨");
                    _renderModalList();
                }
            } finally {
                btn.disabled = false;
            }
        });
    });
    list.querySelectorAll(".cm-reply-text").forEach((ta) => {
        ta.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                ta.closest(".cm-reply-form").querySelector(".cm-reply-submit").click();
            }
        });
    });
}

export function openCommentsModal(path) {
    if (!currentProject) return;
    const modal = _ensureModal();
    _modalPath = path;
    modal.querySelector("#cm-path").textContent = path;
    modal.querySelector("#cm-author").value = getCommentAuthor() || "";
    modal.querySelector("#cm-text").value = "";
    modal.classList.remove("hidden");
    _renderModalList();
    // 자동 마킹 안 함 — 사용자가 NEW 코멘트를 클릭해야 viewed 로 전환
    setTimeout(() => modal.querySelector("#cm-text").focus(), 50);
}

export function closeCommentsModal() {
    if (_modalEl) _modalEl.classList.add("hidden");
    _modalPath = "";
}

// 프로젝트 바뀌면 캐시 새로 로드
window.addEventListener("pv:project-changed", loadComments);

// 단축키 `/` — 현재 선택된 카드의 코멘트 모달 열기.
// 모달이 이미 열려있거나 input/textarea 에 포커스가 있으면 무시.
document.addEventListener("keydown", (e) => {
    if (e.key !== "/") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (_modalEl && !_modalEl.classList.contains("hidden")) return;
    const ae = document.activeElement;
    if (ae && (["INPUT", "TEXTAREA"].includes(ae.tagName) || ae.isContentEditable)) return;
    // 현재 선택된 카드 (lastSelectedCard 우선, 없으면 .selected 카드)
    const card = document.querySelector(".card.selected[data-path]");
    if (!card) return;
    e.preventDefault();
    openCommentsModal(card.dataset.path);
});
