// 진입점 — 모듈 와이어링 + 부트스트랩.

import { bindLightbox } from "./lightbox.js";
import { bindModelControls } from "./modelControls.js";
import { bindProject, loadProjects, updateProjectChip } from "./project.js";
import { bindStatusBar, loadBalance, doLogin } from "./status.js";
import { bindRefImages } from "./refImages.js";
import { bindGenerate } from "./generate.js";
import { bindTagBadgeButtons } from "./tagPicker.js";
import { loadFavorites } from "./favPicker.js";
import { bindGlobalEvents, loadModels, openSpotlight } from "./init.js";
import { spotlight } from "./dom.js";

// 이벤트 와이어링
bindLightbox();
bindModelControls();
bindProject();
bindStatusBar();
bindRefImages();
bindGenerate();
bindTagBadgeButtons();
bindGlobalEvents();

// 데이터 로드 + 부트
loadModels();
loadFavorites();
loadProjects();
updateProjectChip();

// viewer 통합 모드: 항상 표시. 미로그인 시 사용자가 상태바 클릭으로 로그인.
spotlight.classList.remove("hidden");
loadBalance();
