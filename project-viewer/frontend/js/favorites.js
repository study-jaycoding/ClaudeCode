// =====================================================================
// 즐겨찾기 (소스 마커, NEW 알림, 태그, 사이드바 목록) — viewer 의 핵심 데이터
// 다른 모듈은 callback 으로 외부 의존성을 주입한다:
//   - setPreviewCallback(fn): renderFavItem 의 썸네일 클릭 시 텍스트 미리보기
//   - setSourceGridCallback(fn): 태그 필터 변경 시 우측 그리드 갱신
// =====================================================================
import {
    favorites, setFavorites,
    firstFavoritesLoad, setFirstFavoritesLoad,
    activeTagFilter, setActiveTagFilter,
    activeTab,
    currentProject,
    setSuppressClickUntil,
    setLastFocusArea,
} from "./state.js";
import { rootTree } from "./state.js";
import {
    favoritesList, favCountEl, genCountEl, tagFilterBar,
    tabFavorites, lasso,
} from "./dom.js";
import {
    escapeHtml, kindFromPath, generateId, findNodeByPath, isGeneratedPath,
} from "./utils.js";
import { apiGetFavorites, apiPersistFavorites } from "./api.js";
import { lazyScan } from "./lazy-media.js";
import { openLightbox } from "./lightbox.js";
import { pushUndo } from "./undo.js";
import { reapplyPanelSearch } from "./panel-search.js";

// --- 외부 callback (다른 모듈에서 등록) ---
let _previewNode = () => {};
let _refreshSourceGrid = () => {};

export function setPreviewCallback(fn) {
    _previewNode = typeof fn === "function" ? fn : () => {};
}
export function setSourceGridCallback(fn) {
    _refreshSourceGrid = typeof fn === "function" ? fn : () => {};
}

// ── 인덱스 (lookup 최적화) ──
// favorites 가 mutate 될 때마다 rebuildFavIndex() 가 호출되어 동기화됨.
const _favByKey = new Map();          // "project|path" → fav
const _favById = new Map();           // fav.id → fav
const _derivedByFavId = new Map();    // sourceId → 자식 fav[] (역참조)

function _key(project, path) { return project + "|" + path; }

export function rebuildFavIndex() {
    _favByKey.clear();
    _favById.clear();
    _derivedByFavId.clear();
    for (const f of favorites) {
        if (f && f.project && f.path) _favByKey.set(_key(f.project, f.path), f);
        if (f && f.id) _favById.set(f.id, f);
        for (const sid of (f && f.sourceIds) || []) {
            let arr = _derivedByFavId.get(sid);
            if (!arr) { arr = []; _derivedByFavId.set(sid, arr); }
            arr.push(f);
        }
    }
}

export function getFavById(id) { return _favById.get(id); }
export function getDerivedOf(favId) { return _derivedByFavId.get(favId) || []; }

// ── 사이드바 소스 목록 선택 상태 ──
const _favSelected = new Set();
let _lastSelectedFavId = null;
// shift+화살표 / shift-click range 시작점. 단일 선택 시 null 로 리셋.
let _shiftAnchorFavId = null;

/** 즐겨찾기 패널에서 방향(±1) 으로 한 칸 이동. shift=true 면 anchor~target range 다중 선택. */
export function moveFavoritesFocus(direction, shift) {
    if (!favoritesList) return;
    const items = Array.from(favoritesList.querySelectorAll(".fav-item"))
        .filter((el) => el.offsetParent && el.dataset.favId);
    if (items.length === 0) return;
    const ids = items.map((el) => el.dataset.favId);
    let idx = _lastSelectedFavId ? ids.indexOf(_lastSelectedFavId) : -1;
    let next;
    if (idx === -1) {
        next = direction > 0 ? 0 : items.length - 1;
    } else {
        next = Math.max(0, Math.min(items.length - 1, idx + direction));
    }
    const target = items[next];
    if (!target) return;
    setLastFocusArea("favorites");

    if (!shift) {
        // 단일 이동 — 기존 click 핸들러 그대로 사용 (anchor 리셋 / NEW dismiss / 그리드 미러)
        _shiftAnchorFavId = null;
        target.click();
        target.scrollIntoView({ block: "nearest" });
        return;
    }

    // shift+화살표 — anchor~target range (replace), focus 만 갱신, anchor 유지
    if (!_shiftAnchorFavId || ids.indexOf(_shiftAnchorFavId) === -1) {
        _shiftAnchorFavId = _lastSelectedFavId || target.dataset.favId;
    }
    const a = ids.indexOf(_shiftAnchorFavId);
    const b = ids.indexOf(target.dataset.favId);
    _favSelected.clear();
    if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) _favSelected.add(ids[i]);
    }
    _lastSelectedFavId = target.dataset.favId;

    favoritesList.querySelectorAll(".fav-item").forEach((el) => {
        el.classList.toggle("selected", _favSelected.has(el.dataset.favId));
    });
    _mirrorFavSelectionToGrid();

    // 새로 선택된 fav 들의 NEW 도 dismiss (단일 클릭과 일관)
    let dirty = false;
    for (const f of favorites) {
        if (_favSelected.has(f.id) && markCardSeen(f.project, f.path)) dirty = true;
    }
    if (dirty) {
        updateFavCount();
        updateCardNewBadges();
        updateTreeLabelColors();
        // re-render 시 target DOM 이 교체되므로 새 element 찾아서 scroll
        renderFavoritesItems();
        const refreshed = favoritesList.querySelector(
            `.fav-item[data-fav-id="${target.dataset.favId}"]`
        );
        if (refreshed) refreshed.scrollIntoView({ block: "nearest" });
        return;
    }
    target.scrollIntoView({ block: "nearest" });
}

/** 사이드바 _favSelected 의 fav 들을 우측 그리드 카드의 .selected 와 동기화.
 *  좌측에서 선택 변경할 때마다 호출. (그리드→사이드바 역방향은 별개 흐름) */
function _mirrorFavSelectionToGrid() {
    const paths = new Set();
    for (const id of _favSelected) {
        const f = _favById.get(id);
        if (f && f.project === currentProject) paths.add(f.path);
    }
    document.querySelectorAll(".preview-content .card[data-path]").forEach((card) => {
        card.classList.toggle("selected", paths.has(card.dataset.path));
    });
}

export function clearFavSelection() {
    _favSelected.clear();
    _lastSelectedFavId = null;
    if (favoritesList) {
        favoritesList.querySelectorAll(".fav-item.selected")
            .forEach((el) => el.classList.remove("selected"));
    }
    _mirrorFavSelectionToGrid();
}

// 여러 fav 에 같은 태그를 한 번에 추가 (개별 addTag 호출은 매번 re-render 하므로 부적합).
export function addTagsToMany(favIds, tag) {
    tag = (tag || "").trim();
    if (!tag) return;
    const added = [];
    for (const fid of favIds) {
        const fav = _favById.get(fid);
        if (!fav || (fav.tags || []).includes(tag)) continue;
        fav.tags = fav.tags || [];
        fav.tags.push(tag);
        added.push(fid);
    }
    if (added.length === 0) return;
    persistFavorites();
    renderFavorites();
    renderTagFilterBar();
    if (activeTab === "favorites") _refreshSourceGrid(activeTagFilter);
    pushUndo(`태그 추가 #${tag} (${added.length}개)`, async () => {
        for (const fid of added) {
            const f = _favById.get(fid);
            if (f) f.tags = (f.tags || []).filter((t) => t !== tag);
        }
        persistFavorites();
        renderFavorites();
        renderTagFilterBar();
        if (activeTab === "favorites") _refreshSourceGrid(activeTagFilter);
    });
}

// --- 분류 / 조회 ---
export function isFavorite(project, path) {
    return _favByKey.has(_key(project, path));
}
export function getFavorite(project, path) {
    return _favByKey.get(_key(project, path));
}
// 사용자가 isSource = true 로 토글한 항목 (생성물이어도 가능).
export function isSourceFav(fav) {
    return fav && fav.isSource === true;
}
// 현재 viewer 에서 선택된 프로젝트의 소스만 반환.
// 프로젝트 미선택 시 빈 배열 — 소스 탭/사이드바 모두에 자동 적용됨.
export function sourceFavorites() {
    if (!currentProject) return [];
    return favorites.filter((f) => f.project === currentProject && isSourceFav(f));
}

// --- CRUD ---
// persist 직렬화 — 짧은 간격의 연속 mutation (push + markCardSeen 등) 이
// 동시에 POST 되어 서버에 도착 순서가 뒤바뀌면, 옛 스냅샷이 마지막에 쓰여
// 방금 갱신한 seenAt/sourceMarkedAt 이 사라지는 race 가 발생함. queue 로 순차화.
let _persistChain = Promise.resolve();
let _lastPersistAt = 0;
export function persistFavorites() {
    // 어떤 mutation 후든 항상 호출되므로 여기서 인덱스 재동기화
    rebuildFavIndex();
    _lastPersistAt = Date.now();
    // 프로젝트별 분리 — 현재 프로젝트의 favorites 만 저장 (현재 메모리는 그 프로젝트만 보유)
    const proj = currentProject;
    if (!proj) return;  // 프로젝트 없으면 저장 안 함 (data lost 방지)
    const projFavs = favorites.filter((f) => f.project === proj);
    _persistChain = _persistChain
        .then(() => apiPersistFavorites(proj, projFavs))
        .catch(() => {});
}
// SSE callback 에서 사용 — 자기 자신이 방금 쓴 변경으로 발화된 SSE 는 무시.
// 1.5s 안에 다른 클라이언트의 변경이 끼면 그건 다음 SSE tick (≤1s) 에서 잡힘.
export function isOwnPersistRecent() {
    return Date.now() - _lastPersistAt < 1500;
}

export async function initFavorites() {
    try {
        // 현재 프로젝트의 favorites 만 로드. 프로젝트 없으면 모든 프로젝트 통합 (UI 가 일관되게 한 번에 표시).
        const data = await apiGetFavorites(currentProject || "");
        setFavorites(Array.isArray(data.favorites) ? data.favorites
                  : Array.isArray(data) ? data : []);
        let needPersist = false;
        const now = Date.now();
        for (const f of favorites) {
            if (!f.id) { f.id = generateId(); needPersist = true; }
            if (!f.tags) f.tags = [];
            if (!f.note) f.note = "";
            if (!f.sourceIds) f.sourceIds = [];
            // isSource 마이그레이션 (옛날 데이터 호환)
            if (f.isSource === undefined) {
                f.isSource = !isGeneratedPath(f.path);
                needPersist = true;
            }
            // 첫 로드 시 seenAt 미정의 fav 는 모두 본 것으로 마이그레이션.
            // 그 이후 SSE 로 들어오는 새 fav (seenAt 미정의) 는 unseen 으로 표시됨.
            if (firstFavoritesLoad && f.seenAt === undefined) {
                f.seenAt = now;
                needPersist = true;
            }
        }
        if (needPersist) persistFavorites();
        rebuildFavIndex();
        setFirstFavoritesLoad(false);
    } catch {
        setFavorites([]);
        rebuildFavIndex();
    }
    updateFavCount();
    updateTreeLabelColors();
    updateCardMarkers();
    updateCardNewBadges();
    // viewerFavorites 가 교체됐음을 외부에 알림 — spotlight cache 동기화 등.
    // 프로젝트 전환 직후 호출되는 경우 spotlight 가 stale cache 로 필터링하는 버그 방지.
    try { window.dispatchEvent(new CustomEvent("pv:favorites-changed")); } catch {}
}

/** 즐겨찾기 패널의 ● 버튼: 완전 제거 (ID 파기). */
export function removeFromFavorites(project, path) {
    const idx = favorites.findIndex((f) => f.project === project && f.path === path);
    if (idx < 0) return;
    favorites.splice(idx, 1);
    persistFavorites();
    updateFavCount();
    renderFavorites();
}

// --- 소스 토글 ---
/** 내부: isSource 명시 set + UI 갱신. 미등록이면 신규 생성. */
export function _setSourceValue(project, path, value) {
    let fav = _favByKey.get(_key(project, path));
    const now = Date.now();
    if (!fav) {
        fav = {
            id: generateId(),
            project,
            path,
            tags: [],
            note: "",
            sourceIds: [],
            isSource: !!value,
            sourceMarkedAt: value ? now : 0,
            addedAt: now,
        };
        favorites.push(fav);
    } else {
        fav.isSource = !!value;
        if (value) fav.sourceMarkedAt = now;
    }
    // 토글로 새로 소스가 된 fav 는 NEW 로 표시 — 사용자가 카드를 다시 클릭해야 dismiss
    persistFavorites();
    updateFavCount();
    renderFavorites();
    updateCardMarkers();
    updateTreeLabelColors();
    updateCardNewBadges();
    // 소스 탭에 있는 상태에서 토글한 경우 그리드 자체가 바뀌어야 함 (소스 추가/해제 → 카드 표시/숨김).
    if (activeTab === "favorites") _refreshSourceGrid(activeTagFilter);
    // spotlight 도 자기 cache.favorites 를 즉시 갱신해야 — SSE round-trip 기다리면
    // 사용자가 토글 직후 바로 drag 할 때 isSource 판정이 빗나감.
    try { window.dispatchEvent(new CustomEvent("pv:favorites-changed")); } catch {}
}

/** 카드 우상단 마커 클릭 — isSource 토글 (생성물/일반 모두 가능). */
export function toggleSource(project, path) {
    const fav = _favByKey.get(_key(project, path));
    const prev = !!(fav && fav.isSource === true);
    _setSourceValue(project, path, !prev);
    const name = path.split("/").pop();
    pushUndo(`마커 ${prev ? "해제→복원" : "지정→해제"} (${name})`, async () => {
        _setSourceValue(project, path, prev);
    });
}

// --- NEW 알림 (seenAt 기반) ---
function _isUnseen(f, trigger) {
    return !(f.seenAt && f.seenAt >= trigger);
}
// fav 가 "다시 NEW 가 되어야 하는 가장 최근 사건" 의 시각.
// - source 토글된 경우: sourceMarkedAt 우선 (생성물이어도 source 로 새로 표시했으니 NEW).
// - 생성물(Result/) 이지만 source 아님: addedAt 기준 (자동 생성 알림).
// - 둘 다 아님: 알림 대상 아님.
// 세 함수 (isCardNew / markCardSeen / unseenSourcesCount) 가 모두 이 헬퍼 사용 → 어긋남 방지.
function _seenTriggerOf(fav) {
    if (isSourceFav(fav)) return fav.sourceMarkedAt || fav.addedAt || 0;
    if (isGeneratedPath(fav.path)) return fav.addedAt || 0;
    return 0;
}
// 카운트는 그리드(=현재 프로젝트) 와 동일한 범위 + badge 와 같은 _favByKey 를
// 순회해 같은 fav 객체를 본다. 두 source 가 분리되면 count↔badge 가 어긋날 수 있음.
export function unseenSourcesCount() {
    if (!currentProject) return 0;
    let n = 0;
    for (const f of _favByKey.values()) {
        if (f.project !== currentProject) continue;
        if (!isSourceFav(f)) continue;
        if (_isUnseen(f, _seenTriggerOf(f))) n++;
    }
    return n;
}
// 생성 탭의 ✨ 배지 — source 토글 여부와 무관하게 "Result/ 의 새 생성물" 알림.
export function unseenGeneratedCount() {
    if (!currentProject) return 0;
    let n = 0;
    for (const f of _favByKey.values()) {
        if (f.project !== currentProject) continue;
        if (!isGeneratedPath(f.path)) continue;
        if (_isUnseen(f, f.addedAt || 0)) n++;
    }
    return n;
}

/** 카드를 본 것으로 마킹. true 반환 시 UI 갱신 필요. */
export function markCardSeen(project, path) {
    const fav = _favByKey.get(_key(project, path));
    if (!fav) return false;
    const trig = _seenTriggerOf(fav);
    if (trig === 0) return false;
    if (fav.seenAt && fav.seenAt >= trig) return false;
    fav.seenAt = Date.now();
    persistFavorites();
    return true;
}

/** 카드가 "새 항목" 표시 대상인지 — seenAt 이 마지막 trigger 이전이거나 미정의일 때. */
export function isCardNew(project, path) {
    const fav = _favByKey.get(_key(project, path));
    if (!fav) return false;
    const trig = _seenTriggerOf(fav);
    if (trig === 0) return false;
    return _isUnseen(fav, trig);
}

// 생성 탭 배지의 running 상태 — queue.js 가 setRunningCount 로 주입.
let _runningCount = 0;
export function setRunningCount(n) {
    _runningCount = Math.max(0, Number(n) || 0);
    updateGenBadge();
}

/** 생성 탭 아이콘 배지.
 *  running & unseen 둘 다 있으면 분할 알약 [녹|파], 하나만 있으면 단색.
 *  녹색 = 진행중, 파랑 = 확인 대기 NEW. */
export function updateGenBadge() {
    if (!genCountEl) return;
    const r = _runningCount;
    const u = unseenGeneratedCount();
    genCountEl.classList.remove("running", "unseen", "split");
    if (r > 0 && u > 0) {
        genCountEl.classList.remove("hidden");
        genCountEl.classList.add("split");
        genCountEl.innerHTML =
            `<span class="gc-run">${r}</span><span class="gc-new">${u}</span>`;
    } else if (r > 0) {
        genCountEl.classList.remove("hidden");
        genCountEl.classList.add("running");
        genCountEl.textContent = String(r);
    } else if (u > 0) {
        genCountEl.classList.remove("hidden");
        genCountEl.classList.add("unseen");
        genCountEl.textContent = String(u);
    } else {
        genCountEl.classList.add("hidden");
        genCountEl.textContent = "";
    }
}

// --- UI 갱신 (다른 모듈도 호출) ---
export function updateFavCount() {
    const srcN = unseenSourcesCount();
    favCountEl.textContent = String(srcN);
    favCountEl.classList.toggle("hidden", srcN === 0);
    updateGenBadge();
}

/** 현재 프로젝트에서 자손 중 unseen fav 가 하나라도 있는 폴더 path 들 집합. */
function getDirsWithNewDescendants() {
    const newDirs = new Set();
    if (!currentProject) return newDirs;
    for (const f of _favByKey.values()) {
        if (f.project !== currentProject) continue;
        if (!isCardNew(f.project, f.path)) continue;
        const segs = (f.path || "").split("/");
        let acc = "";
        for (let i = 0; i < segs.length - 1; i++) {
            acc = acc ? `${acc}/${segs[i]}` : segs[i];
            newDirs.add(acc);
        }
    }
    return newDirs;
}

/** 트리 라벨에 source/generated/is-new 클래스 동기화.
 *  file-label 은 자기 자신이 NEW 이면 is-new. dir-label 은 그 폴더 아래
 *  어딘가에 unseen fav 가 있으면 is-new (폴더 닫혀있어도 안에 새것 있다는 신호). */
export function updateTreeLabelColors() {
    document.querySelectorAll(".tree .file-label[data-path]").forEach((label) => {
        const path = label.dataset.path;
        const isGen = isGeneratedPath(path);
        const fav = _favByKey.get(_key(currentProject, path));
        const isSrc = !!(fav && fav.isSource === true);
        const isNew = isCardNew(currentProject, path);
        label.classList.toggle("generated", isGen);
        label.classList.toggle("source", isSrc);
        label.classList.toggle("is-new", isNew);
    });
    const newDirs = getDirsWithNewDescendants();
    document.querySelectorAll(".tree .dir-label[data-path]").forEach((label) => {
        label.classList.toggle("is-new", newDirs.has(label.dataset.path));
    });
}

/** 그리드 카드 우상단 마커 갱신.
 *  - 생성물(Result/): 파란 점
 *  - 소스 토글됨: 녹색 점
 *  - 생성물 + 소스: 파란 점 + 녹색 링 (`generated source` 양쪽 class)
 *  - 그 외: 투명한 중립 점
 */
export function updateCardMarkers() {
    document.querySelectorAll(".card .card-marker[data-path]").forEach((btn) => {
        const path = btn.dataset.path;
        const isGen = isGeneratedPath(path);
        const fav = _favByKey.get(_key(currentProject, path));
        const isSrc = !!(fav && fav.isSource === true);
        const cls = ["card-marker"];
        if (isGen) cls.push("generated");
        if (isSrc) cls.push("source");
        if (!isGen && !isSrc) cls.push("neutral");
        btn.className = cls.join(" ");
        btn.title = isSrc
            ? (isGen ? "소스 해제 (생성물 + 소스)" : "소스 해제")
            : (isGen ? "소스로 표시 (생성물)" : "소스로 표시");
    });
}

/** 그리드 카드 NEW 배지 갱신 (좌상단 라임 배지).
 *  파일 카드 = 자기 자신이 unseen 이면 NEW.
 *  폴더 카드 = 자손 중 unseen fav 가 하나라도 있으면 NEW (안에 새것 있다는 신호). */
export function updateCardNewBadges() {
    const newDirs = getDirsWithNewDescendants();
    document.querySelectorAll(".card[data-path]").forEach((card) => {
        const path = card.dataset.path;
        const isDir = card.classList.contains("card-dir");
        const isNew = isDir ? newDirs.has(path) : isCardNew(currentProject, path);
        card.classList.toggle("is-new", isNew);
        const existing = card.querySelector(".new-badge");
        if (isNew && !existing) {
            const badge = document.createElement("span");
            badge.className = "new-badge";
            badge.textContent = "NEW";
            card.appendChild(badge);
        } else if (!isNew && existing) {
            existing.remove();
        }
    });
}

// --- 태그 관리 ---
// 사이드바(renderFavorites) + 태그 필터 바 + 우측 소스 그리드 모두 갱신해야
// 추가/제거가 양쪽에 즉시 반영된다. (이전엔 renderFavorites 만 호출 → 우측은 F5 필요)
function _refreshAfterTagChange() {
    persistFavorites();
    renderFavorites();
    renderTagFilterBar();
    if (activeTab === "favorites") _refreshSourceGrid(activeTagFilter);
}

export function addTag(favId, tag) {
    const fav = _favById.get(favId);
    if (!fav) return;
    tag = tag.trim();
    if (!tag || fav.tags.includes(tag)) return;
    fav.tags.push(tag);
    _refreshAfterTagChange();
    pushUndo(`태그 추가 (#${tag})`, async () => {
        const f = _favById.get(favId);
        if (!f) return;
        f.tags = f.tags.filter((t) => t !== tag);
        _refreshAfterTagChange();
    });
}

export function removeTag(favId, tag) {
    const fav = _favById.get(favId);
    if (!fav) return;
    if (!fav.tags.includes(tag)) return;
    fav.tags = fav.tags.filter((t) => t !== tag);
    _refreshAfterTagChange();
    pushUndo(`태그 제거 (#${tag})`, async () => {
        const f = _favById.get(favId);
        if (!f || f.tags.includes(tag)) return;
        f.tags.push(tag);
        _refreshAfterTagChange();
    });
}

// 태그 입력창에 인라인 자동완성 부착.
// 사용자가 "ㄱ" 입력 → 기존 태그 "공구" 가 있으면 input 에 "공구" 채우고 "구" 부분만 selection.
// 다음 글자 입력하면 그 selection 이 덮어쓰여 새 입력으로 갱신.
export function attachTagAutocomplete(input) {
    let composing = false;
    const tryComplete = () => {
        const cursor = input.selectionStart;
        const typed = input.value.substring(0, cursor);
        if (!typed) return;
        const lower = typed.toLowerCase();
        const match = getAllTags().find((t) => t !== typed && t.toLowerCase().startsWith(lower));
        if (match) {
            input.value = match;
            input.setSelectionRange(typed.length, match.length);
        }
    };
    input.addEventListener("input", (e) => {
        if (composing) return;
        // 사용자가 직접 입력한 경우만 (backspace/delete 등은 무시)
        const t = e.inputType;
        if (t && t !== "insertText" && t !== "insertCompositionText") return;
        tryComplete();
    });
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => {
        composing = false;
        tryComplete();
    });
}

export function getAllTags() {
    const set = new Set();
    sourceFavorites().forEach((f) => (f.tags || []).forEach((t) => set.add(t)));
    return [...set].sort();
}

// --- 태그 필터 바 ---
// 두 위치에 동일 콘텐츠 렌더:
//   1) 사이드바 #tag-filter-bar
//   2) 우측 소스 그리드 상단 #source-tag-filter-bar (showSourceGrid 가 만듦)
function _renderTagFilterInto(target) {
    if (!target) return;
    const tags = getAllTags();
    const sources = sourceFavorites();
    target.innerHTML = "";
    if (tags.length === 0 && sources.length === 0) return;

    // "전체" 칩 제거 — 태그 미선택 = 전체 표시. 같은 태그 다시 클릭 = 해제 (line 아래 토글 로직).

    tags.forEach((tag) => {
        const count = sources.filter((f) => (f.tags || []).includes(tag)).length;
        const chip = document.createElement("span");
        chip.className = "tag-chip" + (activeTagFilter === tag ? " active" : "");
        chip.setAttribute("role", "button");
        chip.innerHTML = `<span class="tag-chip-label">#${escapeHtml(tag)} (${count})</span>`
            + `<button class="tag-chip-x" type="button" title="태그 영구 삭제">✕</button>`;
        chip.querySelector(".tag-chip-label").addEventListener("click", () => {
            setActiveTagFilter(activeTagFilter === tag ? null : tag);
            renderTagFilterBar();
            renderFavoritesItems();
            _refreshSourceGrid(activeTagFilter);
        });
        chip.querySelector(".tag-chip-x").addEventListener("click", (e) => {
            e.stopPropagation();
            removeTagFromAll(tag);
        });
        target.appendChild(chip);
    });
}

export function renderTagFilterBar() {
    _renderTagFilterInto(tagFilterBar);
    // 우측 그리드 영역(있다면)도 함께 갱신
    _renderTagFilterInto(document.getElementById("source-tag-filter-bar"));
}

// 태그를 모든 source favorite 에서 영구 제거 (확인 후) + undo.
export function removeTagFromAll(tag) {
    const affected = sourceFavorites().filter((f) => (f.tags || []).includes(tag));
    if (affected.length === 0) return;
    if (!confirm(`'#${tag}' 태그를 ${affected.length}개 항목에서 모두 제거하시겠습니까?`)) return;
    const ids = affected.map((f) => f.id);
    for (const f of affected) {
        f.tags = (f.tags || []).filter((t) => t !== tag);
    }
    // 현재 필터가 지워질 태그였다면 전체로 복귀
    if (activeTagFilter === tag) setActiveTagFilter(null);
    persistFavorites();
    renderFavorites();
    _refreshSourceGrid(activeTagFilter);
    pushUndo(`태그 #${tag} 일괄 제거 (${ids.length}개)`, async () => {
        for (const fid of ids) {
            const f = _favById.get(fid);
            if (f && !(f.tags || []).includes(tag)) {
                f.tags = f.tags || [];
                f.tags.push(tag);
            }
        }
        persistFavorites();
        renderFavorites();
        _refreshSourceGrid(activeTagFilter);
    });
}

// --- 사이드바 즐겨찾기 목록 ---
export function renderFavorites() {
    renderTagFilterBar();
    renderFavoritesItems();
}

export function renderFavoritesItems() {
    let filtered = sourceFavorites();
    if (activeTagFilter) {
        filtered = filtered.filter((f) => (f.tags || []).includes(activeTagFilter));
    }
    filtered.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    if (filtered.length === 0) {
        let msg;
        if (!currentProject) {
            msg = "프로젝트를 먼저 선택하세요";
        } else if (activeTagFilter) {
            msg = `"#${escapeHtml(activeTagFilter)}" 태그가 없습니다`;
        } else {
            msg = "등록된 소스가 없습니다";
        }
        favoritesList.innerHTML = `<li class="empty">${msg}</li>`;
        return;
    }

    favoritesList.innerHTML = "";
    for (const fav of filtered) {
        favoritesList.appendChild(renderFavItem(fav));
    }
    // 리스트 재구성 후 검색 필터 다시 적용
    reapplyPanelSearch();
    lazyScan(favoritesList);
}

function renderFavItem(fav) {
    const kind = kindFromPath(fav.path);
    const url = `/media?project=${encodeURIComponent(fav.project)}&path=${encodeURIComponent(fav.path)}`;
    const isNew = isCardNew(fav.project, fav.path);
    const li = document.createElement("li");
    li.className = "fav-item"
        + (_favSelected.has(fav.id) ? " selected" : "")
        + (isNew ? " is-new" : "");
    li.dataset.favId = fav.id;

    let thumbHtml;
    if (kind === "image") {
        thumbHtml = `<img data-lazy-src="${url}" loading="lazy" alt="" />`;
    } else if (kind === "video") {
        thumbHtml = `<video data-lazy-src="${url}" preload="none" muted></video>`;
    } else {
        thumbHtml = `<span>📄</span>`;
    }

    const tagsHtml = (fav.tags || [])
        .map((t) => `<span class="tag-chip small" data-tag="${escapeHtml(t)}">#${escapeHtml(t)} <span class="tag-x">✕</span></span>`)
        .join("");

    li.innerHTML = `
        ${isNew ? `<span class="new-badge">NEW</span>` : ""}
        <div class="fav-thumb ${kind !== "image" && kind !== "video" ? "fav-thumb-other" : ""}">${thumbHtml}</div>
        <div class="fav-body">
            <div class="fav-info">
                <div class="fav-project">${escapeHtml(fav.project)}</div>
                <div class="fav-path">${escapeHtml(fav.path)}</div>
                <div class="fav-id">ID: ${escapeHtml(fav.id)}</div>
            </div>
            <div class="fav-tags">
                ${tagsHtml}
                <button class="tag-add-btn" type="button" title="태그 추가">+</button>
            </div>
        </div>
        <button class="fav-remove" type="button" title="소스 해제">●</button>`;

    // 원본 파일이 삭제됐을 때 broken 썸네일 대신 "파일 없음" 표시
    const fmedia = li.querySelector(".fav-thumb img, .fav-thumb video");
    if (fmedia) {
        const onErr = () => {
            const wrap = li.querySelector(".fav-thumb");
            if (!wrap || wrap.classList.contains("missing")) return;
            wrap.classList.add("missing");
            wrap.innerHTML = `<span class="fav-thumb-missing" title="원본 파일이 없습니다">⚠</span>`;
        };
        if (fmedia.tagName === "IMG" && fmedia.complete && fmedia.naturalWidth === 0) onErr();
        else fmedia.addEventListener("error", onErr);
    }

    // 썸네일 클릭 → 라이트박스 (이미지/비디오) 또는 텍스트 미리보기 + NEW dismiss.
    // (이전엔 spotlight 가 떠 있으면 skip 했으나, docked spotlight 는 항상 visible
    //  이라 항상 skip 되어 lightbox 가 영원히 안 열렸음 — 원래 동작 복원.)
    li.querySelector(".fav-thumb").addEventListener("click", () => {
        const node = { name: fav.path.split("/").pop(), path: fav.path, kind, size: 0 };
        if (kind === "image" || kind === "video") {
            openLightbox(fav.project, node);
        } else if (rootTree && currentProject === fav.project) {
            const tn = findNodeByPath(rootTree, fav.path);
            if (tn) _previewNode(fav.project, tn);
        }
        if (markCardSeen(fav.project, fav.path)) {
            updateFavCount();
            updateCardNewBadges();
            updateTreeLabelColors();
            renderFavoritesItems();
        }
    });

    li.querySelectorAll(".tag-chip.small").forEach((chip) => {
        chip.querySelector(".tag-x").addEventListener("click", (e) => {
            e.stopPropagation();
            removeTag(fav.id, chip.dataset.tag);
        });
    });

    li.querySelector(".tag-add-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        const tagsDiv = li.querySelector(".fav-tags");
        const btn = li.querySelector(".tag-add-btn");
        if (tagsDiv.querySelector(".tag-input")) {
            tagsDiv.querySelector(".tag-input").focus();
            return;
        }
        const input = document.createElement("input");
        input.type = "text";
        input.className = "tag-input";
        input.placeholder = "태그 입력";
        input.maxLength = 20;
        tagsDiv.insertBefore(input, btn);
        input.focus();
        attachTagAutocomplete(input);

        const commitTag = () => {
            const val = input.value.trim();
            if (val) addTag(fav.id, val);
            else { input.remove(); }
        };
        input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); commitTag(); }
            if (ev.key === "Escape") input.remove();
        });
        input.addEventListener("blur", commitTag);
    });

    li.querySelector(".fav-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        removeFromFavorites(fav.project, fav.path);
    });

    // li 본체 클릭 → 선택 (썸네일/태그/버튼/입력 영역은 자체 핸들러가 처리하므로 제외).
    li.addEventListener("click", (e) => {
        if (e.target.closest(".fav-thumb")) return;
        if (e.target.closest(".tag-chip.small")) return;
        if (e.target.closest(".tag-add-btn")) return;
        if (e.target.closest(".fav-remove")) return;
        if (e.target.closest(".tag-input")) return;

        setLastFocusArea("favorites");

        if (e.ctrlKey || e.metaKey) {
            if (_favSelected.has(fav.id)) _favSelected.delete(fav.id);
            else _favSelected.add(fav.id);
            _lastSelectedFavId = fav.id;
        } else if (e.shiftKey && _lastSelectedFavId) {
            const items = Array.from(favoritesList.querySelectorAll(".fav-item"));
            const ids = items.map((el) => el.dataset.favId);
            const a = ids.indexOf(_lastSelectedFavId);
            const b = ids.indexOf(fav.id);
            if (a >= 0 && b >= 0) {
                const [lo, hi] = a < b ? [a, b] : [b, a];
                for (let i = lo; i <= hi; i++) _favSelected.add(ids[i]);
            }
        } else {
            _favSelected.clear();
            _favSelected.add(fav.id);
            _lastSelectedFavId = fav.id;
        }
        favoritesList.querySelectorAll(".fav-item").forEach((el) => {
            el.classList.toggle("selected", _favSelected.has(el.dataset.favId));
        });
        _mirrorFavSelectionToGrid();
        // 본체 클릭으로도 NEW dismiss (그리드 카드와 동일 동작)
        if (markCardSeen(fav.project, fav.path)) {
            updateFavCount();
            updateCardNewBadges();
            updateTreeLabelColors();
            renderFavoritesItems();
        }
    });

    return li;
}

// ` (backtick) 키로 일괄 태그 입력 — 사이드바 fav-item 선택 또는 우측 그리드 card 선택 둘 다 처리.
// favorites.js 모듈 로드 시 한 번 등록.
function _openBatchTagInput(target, ids) {
    if (!target || !ids || ids.length === 0) return;
    const tagsDiv = target.querySelector(".fav-tags") || target.querySelector(".card-tags");
    const btn = target.querySelector(".tag-add-btn");
    if (!tagsDiv || !btn) return;
    const existing = tagsDiv.querySelector(".tag-input");
    if (existing) { existing.focus(); return; }

    const input = document.createElement("input");
    input.type = "text";
    input.className = "tag-input";
    input.placeholder = ids.length > 1 ? `태그 (${ids.length}개에 적용)` : "태그 입력";
    input.maxLength = 20;
    tagsDiv.insertBefore(input, btn);
    input.focus();
    attachTagAutocomplete(input);

    let committed = false;
    const cleanup = () => {
        document.removeEventListener("mouseup", onOutsideMouseUp, true);
    };
    const commit = () => {
        if (committed) return;
        committed = true;
        cleanup();
        const val = input.value.trim();
        if (val) addTagsToMany(ids, val);
        if (input.parentNode) input.remove();
    };
    // 외부 mouseup 감지 — drag 가 진행 중이면 mouseup 은 drop 직후에야 발화하므로
    // commit→addTagsToMany→renderFavorites 가 dragstart 를 abort 시키지 않는다.
    // (이전엔 mousedown capture 라 drag 첫 이벤트를 잡아 drag 가 깨졌음.)
    const onOutsideMouseUp = (ev) => {
        if (!input.isConnected) { cleanup(); return; }
        if (input.contains(ev.target)) return;
        commit();
    };
    setTimeout(() => document.addEventListener("mouseup", onOutsideMouseUp, true), 0);

    input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        else if (ev.key === "Escape") { committed = true; cleanup(); input.remove(); }
        ev.stopPropagation();
    });
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("mousedown", (ev) => ev.stopPropagation());
    input.addEventListener("blur", commit);
}

document.addEventListener("keydown", (e) => {
    // 입력 중이면 무시
    const ae = document.activeElement;
    if (ae && (["INPUT", "TEXTAREA"].includes(ae.tagName) || ae.isContentEditable)) return;

    if (e.key === "Escape" && _favSelected.size > 0) {
        clearFavSelection();
        return;
    }
    if (e.key !== "`") return;
    if (activeTab !== "favorites") return;

    // 우선순위: 사이드바 fav-item 선택 → 우측 그리드 card 선택.
    if (_favSelected.size > 0) {
        e.preventDefault();
        const ids = Array.from(_favSelected);
        const firstLi = favoritesList.querySelector(`.fav-item[data-fav-id="${CSS.escape(ids[0])}"]`);
        _openBatchTagInput(firstLi, ids);
        return;
    }

    // 우측 그리드의 selected 카드들 — path → fav.id 변환
    const selectedCards = document.querySelectorAll(".preview-content .card.selected[data-path]");
    if (selectedCards.length === 0) return;
    const ids = [];
    let firstCard = null;
    for (const card of selectedCards) {
        const fav = _favByKey.get(_key(currentProject, card.dataset.path));
        if (fav && fav.id) {
            ids.push(fav.id);
            if (!firstCard) firstCard = card;
        }
    }
    if (ids.length === 0) return;
    e.preventDefault();
    _openBatchTagInput(firstCard, ids);
});

// 사이드바 소스 목록 바깥 클릭 시 선택 해제.
// "다른 곳" = fav-item 외 영역 전부 (사이드바 안의 빈 공간도 포함).
// 단, 편집 중인 tag-input 안의 클릭은 유지.
document.addEventListener("click", (e) => {
    if (_favSelected.size === 0) return;
    if (e.target.closest(".fav-item")) return;
    if (e.target.closest(".tag-input")) return;
    clearFavSelection();
});

// ── 사이드바 lasso 드래그 선택 ──
// favorites 탭 패널의 빈 영역에서 드래그 → 사각형 안의 fav-item 들을 선택.
let _favLassoStart = null;
let _favLassoActive = false;
let _favLassoPreSelected = null;

function _applyFavLassoSelection(rectX, rectY, rectW, rectH) {
    const rx2 = rectX + rectW;
    const ry2 = rectY + rectH;
    favoritesList.querySelectorAll(".fav-item").forEach((el) => {
        const r = el.getBoundingClientRect();
        const overlap = !(r.right < rectX || r.left > rx2 || r.bottom < rectY || r.top > ry2);
        const id = el.dataset.favId;
        if (_favLassoStart && _favLassoStart.ctrl) {
            if (overlap) _favSelected.add(id);
            else if (!_favLassoPreSelected.has(id)) _favSelected.delete(id);
        } else {
            if (overlap) _favSelected.add(id);
            else _favSelected.delete(id);
        }
        el.classList.toggle("selected", _favSelected.has(id));
    });
}

if (tabFavorites) {
    tabFavorites.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest(".fav-item")) return;
        if (e.target.closest("button, a, input, textarea, select")) return;
        if (e.target.closest(".tag-chip")) return;
        e.preventDefault();
        _favLassoStart = { x: e.clientX, y: e.clientY, ctrl: e.ctrlKey || e.metaKey };
        _favLassoActive = false;
        _favLassoPreSelected = _favLassoStart.ctrl ? new Set(_favSelected) : null;
    });
}

document.addEventListener("mousemove", (e) => {
    if (!_favLassoStart) return;
    const dx = e.clientX - _favLassoStart.x;
    const dy = e.clientY - _favLassoStart.y;
    if (!_favLassoActive && Math.abs(dx) + Math.abs(dy) > 4) {
        _favLassoActive = true;
        if (!_favLassoStart.ctrl) {
            _favSelected.clear();
            favoritesList.querySelectorAll(".fav-item.selected")
                .forEach((el) => el.classList.remove("selected"));
        }
        lasso.classList.remove("hidden");
    }
    if (!_favLassoActive) return;
    const x = Math.min(e.clientX, _favLassoStart.x);
    const y = Math.min(e.clientY, _favLassoStart.y);
    const w = Math.abs(dx);
    const h = Math.abs(dy);
    lasso.style.left = x + "px";
    lasso.style.top = y + "px";
    lasso.style.width = w + "px";
    lasso.style.height = h + "px";
    _applyFavLassoSelection(x, y, w, h);
    _mirrorFavSelectionToGrid();
});

document.addEventListener("mouseup", () => {
    if (_favLassoActive) {
        lasso.classList.add("hidden");
        lasso.style.width = "0";
        lasso.style.height = "0";
        // mouseup 직후 발생하는 click 을 잠시 무시 (lasso 결과 보존)
        setSuppressClickUntil(Date.now() + 250);
    }
    _favLassoStart = null;
    _favLassoActive = false;
    _favLassoPreSelected = null;
});
