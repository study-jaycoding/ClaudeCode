// =====================================================================
// 전역 키보드 단축키
// - Esc: 라이트박스 닫기 / 선택 해제
// - Ctrl+Z: 되돌리기
// - Ctrl+A: 그리드 전체 선택
// - F2: 단일 선택 이름 변경
// - Delete: 선택 삭제 (다중)
// - Enter: 단일 선택 열기 (폴더 진입 / 이미지·비디오 라이트박스 / 텍스트 inline)
// =====================================================================
import { lightbox, contextPopup, treeMenu, previewContent } from "./dom.js";
import { closeLightbox, openLightbox } from "./lightbox.js";
import {
    clearSelection, getSelectedPaths,
    syncTreeSelection, refreshDraggable,
} from "./selection.js";
import {
    currentProject, currentDir, rootTree, setCurrentDir, setLastSelectedCard,
} from "./state.js";
import { undoLast } from "./undo.js";
import { findNodeByPath } from "./utils.js";
import {
    renameFilePrompt, deleteFilesConfirm,
    createDefaultFolderInside, startInlineRenameForPath,
} from "./menus.js";
import { showFolderGrid, preview } from "./grid.js";
import { closeContextPopup } from "./popup.js";

function openPath(project, path) {
    if (!rootTree) return;
    const node = findNodeByPath(rootTree, path);
    if (!node) return;
    closeContextPopup();
    if (node.type === "dir") {
        setCurrentDir(node.path);
        showFolderGrid(project, node);
    } else if (node.kind === "image" || node.kind === "video") {
        openLightbox(project, node);
    } else {
        preview(project, node);
    }
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !lightbox.classList.contains("hidden")) {
        closeLightbox();
        return;
    }
    // Esc 로 다중 선택 해제 (라이트박스 / 팝업 / 트리 메뉴가 안 떠 있을 때만)
    if (e.key === "Escape"
        && lightbox.classList.contains("hidden")
        && contextPopup.classList.contains("hidden")
        && treeMenu.classList.contains("hidden")) {
        clearSelection();
        return;
    }

    // input/textarea/contenteditable 포커스 시 단축키 무시
    // (스포트라이트 프롬프트는 <div contenteditable> 이라 tagName 체크만으론 부족)
    const ae = document.activeElement;
    if (ae && (["INPUT", "TEXTAREA"].includes(ae.tagName) || ae.isContentEditable)) return;

    // Ctrl+Z 로 마지막 작업 되돌리기 (이동/이름변경/마커/태그)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoLast();
        return;
    }

    // Ctrl+Shift+N → 현재 폴더에 "새 폴더" 생성 + 인라인 rename
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n") {
        if (!currentProject) return;
        e.preventDefault();
        const sel = getSelectedPaths();
        let parent = currentDir || "";
        if (sel.length === 1) {
            const node = findNodeByPath(rootTree, sel[0]);
            if (node && node.type === "dir") parent = sel[0];
        }
        createDefaultFolderInside(currentProject, parent);
        return;
    }

    // Ctrl+A 로 그리드 전체 선택
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        const cards = previewContent.querySelectorAll(".card");
        if (cards.length > 0) {
            e.preventDefault();
            cards.forEach((c) => c.classList.add("selected"));
            setLastSelectedCard(cards[cards.length - 1]);
            syncTreeSelection();
            refreshDraggable();
        }
        return;
    }

    if (!currentProject) return;
    const sel = getSelectedPaths();

    // F2 → 인라인 이름 변경. 그리드 단일 선택 또는 트리 active 라벨.
    if (e.key === "F2") {
        let target = null;
        if (sel.length === 1) target = sel[0];
        else {
            const activeLabel = document.querySelector(".tree .active[data-path]");
            if (activeLabel) target = activeLabel.dataset.path;
        }
        if (target) {
            e.preventDefault();
            // 트리 라벨이 있으면 인라인, 없으면 prompt fallback
            if (!startInlineRenameForPath(currentProject, target)) {
                renameFilePrompt(currentProject, target);
            }
            return;
        }
    }
    // Delete → 선택 항목 삭제 (다중 가능)
    if (e.key === "Delete" && sel.length > 0) {
        e.preventDefault();
        deleteFilesConfirm(currentProject, sel);
        return;
    }
    // Enter → 단일 선택 열기 (이미지/비디오 라이트박스, 폴더 진입)
    if (e.key === "Enter" && sel.length === 1) {
        e.preventDefault();
        openPath(currentProject, sel[0]);
        return;
    }
});
