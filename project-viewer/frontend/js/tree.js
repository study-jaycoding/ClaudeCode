// =====================================================================
// 사이드바 파일 트리 — 폴더/파일 라벨 렌더링 + 드래그앤드롭 이동
// 폴더/파일 우클릭 = 컨텍스트 메뉴 (callback)
// 파일 라벨 클릭 = 부모 폴더 그리드 진입 + 카드 selected 표시 (callback)
// =====================================================================
import { fileTree, previewContent } from "./dom.js";
import {
    kindIcon, humanSize, cssQueryEscape, findNodeByPath,
} from "./utils.js";
import { rootTree, setCurrentDir } from "./state.js";
import { updateTreeLabelColors } from "./favorites.js";
import { selectCard, getSelectedPaths } from "./selection.js";

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
}

function renderNode(node, project) {
    const li = document.createElement("li");

    if (node.type === "dir") {
        li.className = "dir";
        const row = document.createElement("div");
        row.className = "dir-row";

        const chev = document.createElement("span");
        chev.className = "chevron";
        chev.textContent = node.children.length > 0 ? "▼" : "·";
        if (node.children.length > 0) {
            chev.addEventListener("click", (e) => {
                e.stopPropagation();
                const collapsed = li.classList.toggle("collapsed");
                chev.textContent = collapsed ? "▶" : "▼";
            });
        }
        row.appendChild(chev);

        const label = document.createElement("span");
        label.className = "dir-label";
        label.textContent = "📁 " + node.name;
        label.dataset.path = node.path;
        label.addEventListener("click", () => {
            setActiveLabel(label);
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

            // 1) 트리 → 트리 (기존)
            const fromTreePath = e.dataTransfer.getData("text/x-tree-path");
            if (fromTreePath) {
                const fromDir = fromTreePath.includes("/")
                    ? fromTreePath.substring(0, fromTreePath.lastIndexOf("/")) : "";
                if (fromDir === node.path) return;
                await _moveFile(project, fromTreePath, node.path);
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

