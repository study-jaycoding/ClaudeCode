// 진입점 — 모듈 와이어링 + 부트스트랩.

import { bindLightbox } from "./modules/lightbox.js";
import { bindModelControls } from "./modules/modelControls.js";
import { bindProject, loadProjects, updateProjectChip } from "./modules/project.js";
import { bindStatusBar, loadBalance, doLogin } from "./modules/status.js";
import { bindRefImages } from "./modules/refImages.js";
import { bindGenerate } from "./modules/generate.js";
import { bindTagBadgeButtons } from "./modules/tagPicker.js";
import { loadFavorites } from "./modules/favPicker.js";
import { bindGlobalEvents, loadModels, openSpotlight } from "./modules/init.js";
import { spotlight } from "./modules/dom.js";

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

(async function init() {
    const connected = await loadBalance();
    if (!connected) {
        spotlight.classList.add("hidden");
        await doLogin();
    }
    openSpotlight();
})();
