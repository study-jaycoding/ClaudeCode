// state.project ↔ viewer 의 currentProject 자동 동기화.
// 별도 UI 없음 — viewer 상단 드롭다운에서만 선택, spotlight 는 따라간다.

import { state } from "./state.js";
import { currentProject as viewerCurrentProject } from "../state.js";

export function syncProjectFromViewer() {
    state.project = viewerCurrentProject || "";
}

// 초기 동기화 + viewer 변경 이벤트 구독
syncProjectFromViewer();
window.addEventListener("pv:project-changed", syncProjectFromViewer);
