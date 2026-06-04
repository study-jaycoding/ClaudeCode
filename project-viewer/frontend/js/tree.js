// =====================================================================
// 사이드바 파일 트리 — 폴더/파일 라벨 렌더링 + 드래그앤드롭 이동
// 폴더/파일 우클릭 = 컨텍스트 메뉴 (callback)
// 파일 라벨 클릭 = 부모 폴더 그리드 진입 + 카드 selected 표시 (callback)
// =====================================================================
import { fileTree, previewContent } from "./dom.js";
import {
    kindIcon, humanSize, cssQueryEscape, findNodeByPath,
} from "./utils.js";
import { rootTree, setCurrentDir, setLastFocusArea } from "./state.js";
import { updateTreeLabelColors } from "./favorites.js";
import { selectCard, getSelectedPaths } from "./selection.js";
import { reapplyPanelSearch } from "./panel-search.js";

// ── 폴더 collapsed 상태 영구 저장 ─────────────────────────────
// 트리가 재렌더돼도(SSE 갱신, 프로젝트 전환 등) 사용자가 접어둔 폴더는 그대로 유지.
// 키는 모든 프로젝트 공유 (같은 이름의 경로면 의도가 보통 동일).
const COLLAPSED_KEY = "viewer.collapsedDirs";
const _collapsedDirs = new Set((() => {
    try {
        const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
        return Array.isArray(v) ? v : [];
    } catch { return []; }
})());
function _saveCollapsed() {
    try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([..._collapsedDirs]));
    } catch {}
}

// 외부 callback (grid / menus 모듈)
let _showFolderGrid = () => {};
let _openTreeMenu = () => {};
let _moveFile = async () => false;
let _createFolderInside = () => {};

export function setShowFolderGridCallback(fn) {
    _showFolderGrid = typeof fn === "function" ? fn : () => {};
}
export function setOpenTreeMenuCallback(fn) {
    _openTreeMenu = typeof fn === "function" ? fn : () => {};
}
export function setMoveFileCallback(fn) {
    _moveFile = typeof fn === "function" ? fn : async () => false;
}
export function setCreateFolderInsideCallback(fn) {
    _createFolderInside = typeof fn === "function" ? fn : () => {};
}

/** 트리에서 활성 라벨(현재 폴더/파일) 표시 동기화. */
export function setActiveLabel(label) {
    document.querySelectorAll(".tree .active").forEach((el) => el.classList.remove("active"));
    label.classList.add("active");
}

/** path 로 활성 라벨 설정 — file-tree 와 gen-tree 양쪽 모두에 적용 (탭에 따라 보이는 트리가 달라지므로). */
export function setActiveLabelByPath(path, isDir) {
    document.querySelectorAll(".tree .active").forEach((el) => el.classList.remove("active"));
    const cls = isDir ? "dir-label" : "file-label";
    document.querySelectorAll(`.tree .${cls}[data-path="${cssQueryEscape(path)}"]`)
        .forEach((l) => l.classList.add("active"));
}

/** 전체 트리 재렌더. target 미지정 시 사이드바의 fileTree. */
export function renderTree(rootNode, project, target = fileTree) {
    target.innerHTML = "";
    if (!rootNode || !rootNode.children || rootNode.children.length === 0) {
        const msg = target === fileTree ? "폴더가 비어있습니다" : "아직 생성된 폴더가 없습니다";
        target.innerHTML = `<li class="empty">${msg}</li>`;
        return;
    }
    for (const child of rootNode.children) {
        target.appendChild(renderNode(child, project));
    }
    // 두 트리 모두 동일 selector(`.tree .file-label`) 로 색상 동기화.
    updateTreeLabelColors();
    // 트리가 통째로 재구성됐으니 현재 검색 필터 다시 적용
    reapplyPanelSearch();
}

function renderNode(node, project) {
    const li = document.createElement("li");

    if (node.type === "dir") {
        // 저장된 collapsed 상태 복원 — 트리 재렌더 후에도 사용자가 접었던 폴더 유지.
        const startCollapsed = node.children.length > 0 && _collapsedDirs.has(node.path);
        li.className = "dir" + (startCollapsed ? " collapsed" : "");
        const row = document.createElement("div");
        row.className = "dir-row";

        const chev = document.createElement("span");
        chev.className = "chevron";
        if (node.children.length === 0) {
            chev.textContent = "·";
        } else {
            chev.textContent = startCollapsed ? "▶" : "▼";
            chev.addEventListener("click", (e) => {
                e.stopPropagation();
                const collapsed = li.classList.toggle("collapsed");
                chev.textContent = collapsed ? "▶" : "▼";
                if (collapsed) _collapsedDirs.add(node.path);
                else _collapsedDirs.delete(node.path);
                _saveCollapsed();
            });
        }
        row.appendChild(chev);

        const label = document.createElement("span");
        label.className = "dir-label";
        label.textContent = "📁 " + node.name;
        label.dataset.path = node.path;
        label.addEventListener("click", () => {
            setActiveLabel(label);
            setLastFocusArea("tree");
            setCurrentDir(node.path);
            _showFolderGrid(project, node);
        });
        // 폴더 우클릭 = 컨텍스트 메뉴
        label.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            _openTreeMenu(e.clientX, e.clientY, project, [node.path]);
        });
        row.appendChild(label);

        // 폴더 row 끝의 `+` 버튼 — 이 폴더 안에 하위 폴더 생성
        const addBtn = document.createElement("button");
        addBtn.className = "dir-add-btn";
        addBtn.type = "button";
        addBtn.textContent = "+";
        addBtn.title = "하위 폴더 만들기";
        addBtn.tabIndex = -1;
        addBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            _createFolderInside(project, node.path);
        });
        addBtn.addEventListener("mousedown", (e) => e.stopPropagation());
        row.appendChild(addBtn);

        li.appendChild(row);

        // 폴더 = 드롭 대상 — 내부 트리 드래그 OR spotlight 결과(저장된 /media URL).
        const isInternalDrag = (e) => {
            if (!e.dataTransfer) return false;
            const t = Array.from(e.dataTransfer.types);
            return t.includes("text/x-tree-path") || t.includes("application/x-hf-ref");
        };

        row.addEventListener("dragover", (e) => {
            if (!isInternalDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            row.classList.add("drag-over");
        });
        row.addEventListener("dragleave", (e) => {
            if (!isInternalDrag(e)) return;
            e.stopPropagation();
            row.classList.remove("drag-over");
        });
        row.addEventListener("drop", async (e) => {
            if (!isInternalDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            row.classList.remove("drag-over");

            // 1) 트리/그리드 → 트리 폴더 (단일/다중)
            const multi = e.dataTransfer.getData("text/x-tree-paths");
            const single = e.dataTransfer.getData("text/x-tree-path");
            const all = multi ? multi.split("\n").filter(Boolean)
                              : (single ? [single] : []);
            const paths = all.filter((p) => {
                const fromDir = p.includes("/") ? p.substring(0, p.lastIndexOf("/")) : "";
                return fromDir !== node.path;
            });
            if (paths.length > 0) {
                // 마지막 한 번만 reload 처리 — N개 이동에 reload 1회
                for (let i = 0; i < paths.length; i++) {
                    const isLast = i === paths.length - 1;
                    await _moveFile(project, paths[i], node.path, !isLast);
                }
                return;
            }

            // 2) spotlight 결과 → 폴더 이동
            //    dragUrl = /media?project=X&path=Result/hf_xxx.png (같은 프로젝트일 때만)
            const hfRef = e.dataTransfer.getData("application/x-hf-ref")
                || e.dataTransfer.getData("text/uri-list") || "";
            if (!hfRef) return;
            try {
                const u = new URL(hfRef.split(/\r?\n/)[0].trim(), location.origin);
                const dropProj = u.searchParams.get("project");
                const dropPath = u.searchParams.get("path");
                if (!dropPath) return;
                if (dropProj && dropProj !== project) return;
                const fromDir = dropPath.includes("/")
                    ? dropPath.substring(0, dropPath.lastIndexOf("/")) : "";
                if (fromDir === node.path) return;
                await _moveFile(project, dropPath, node.path);
            } catch { /* URL 파싱 실패 시 무시 */ }
        });

        const ul = document.createElement("ul");
        for (const child of node.children) {
            ul.appendChild(renderNode(child, project));
        }
        li.appendChild(ul);
    } else {
        li.className = "file kind-" + node.kind;
        const label = document.createElement("span");
        label.className = "file-label";
        label.textContent = kindIcon(node.kind) + " " + node.name;
        label.title = `${node.path} · ${humanSize(node.size)}`;
        label.dataset.path = node.path;
        label.addEventListener("click", () => {
            setActiveLabel(label);
            const slash = node.path.lastIndexOf("/");
            const parentDir = slash >= 0 ? node.path.substring(0, slash) : "";
            setCurrentDir(parentDir);
            // 부모 폴더 그리드 표시 후 해당 파일 카드를 selected 표시
            const parentNode = findNodeByPath(rootTree, parentDir) || rootTree;
            _showFolderGrid(project, parentNode);
            const cardEl = previewContent.querySelector(
                `.card[data-path="${cssQueryEscape(node.path)}"]`
            );
            if (cardEl) {
                selectCard(cardEl);
                cardEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
            }
            // selectCard 가 lastFocusArea 를 "grid" 로 바꿔놓으므로 마지막에 되돌림.
            // 트리 라벨 클릭/방향키 이동은 항상 트리 영역 유지가 자연스러움.
            setLastFocusArea("tree");
        });

        // 파일 우클릭 = 컨텍스트 메뉴
        label.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            // 다중 선택 포함 시 그 선택 그대로
            const sel = getSelectedPaths();
            const paths = sel.includes(node.path) && sel.length > 1 ? sel : [node.path];
            _openTreeMenu(e.clientX, e.clientY, project, paths);
        });

        // 파일 = 드래그 가능 (트리 → 폴더 이동)
        label.draggable = true;
        label.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/x-tree-path", node.path);
            e.dataTransfer.effectAllowed = "move";
            label.classList.add("dragging");
        });
        label.addEventListener("dragend", () => {
            label.classList.remove("dragging");
        });

        li.appendChild(label);
    }
    return li;
}

