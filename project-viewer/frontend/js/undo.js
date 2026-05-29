// =====================================================================
// Undo 스택 (이동/이름변경/마커/태그) — Ctrl+Z
// 삭제는 의도적으로 제외 (실파일 변경이라 휴지통식 백업 없이는 위험)
// =====================================================================
import { undoStack } from "./state.js";
import { previewInfo } from "./dom.js";

const UNDO_MAX = 50;

/** undo entry 등록. label 은 사용자에게 보일 작업 이름, undoFn 은 inverse 작업. */
export function pushUndo(label, undoFn) {
    undoStack.push({ label, fn: undoFn });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
}

/** 마지막 작업 되돌리기 — Ctrl+Z 핸들러에서 호출. */
export async function undoLast() {
    const entry = undoStack.pop();
    if (!entry) {
        previewInfo.textContent = "↩ 되돌릴 작업이 없습니다";
        return;
    }
    previewInfo.textContent = `↩ 되돌리는 중: ${entry.label}...`;
    try {
        await entry.fn();
        previewInfo.textContent = `✓ 되돌렸습니다: ${entry.label}`;
    } catch (err) {
        previewInfo.textContent = `⚠ 되돌리기 실패: ${err.message}`;
    }
}
