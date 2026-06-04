// 진입점 — 모듈 와이어링 + 부트스트랩.

import { bindLightbox } from "./lightbox.js";
import { bindModelControls } from "./modelControls.js";
import "./project.js";  // viewer currentProject 자동 동기화 (사이드 효과 only)
import { bindStatusBar, loadBalance } from "./status.js";
import { bindRefImages } from "./refImages.js";
import { bindGenerate } from "./generate.js";
import { bindTagBadgeButtons } from "./tagPicker.js";
import { loadFavorites } from "./favPicker.js";
import { bindGlobalEvents, loadModels } from "./init.js";
import { spotlight } from "./dom.js";
import { favorites as viewerFavorites } from "../state.js";
import { cache } from "./state.js";

// 이벤트 와이어링
bindLightbox();
bindModelControls();
bindStatusBar();
bindRefImages();
bindGenerate();
bindTagBadgeButtons();
bindGlobalEvents();

// 데이터 로드 + 부트
loadModels();
loadFavorites();

// viewer 가 favorites 를 갱신할 때마다 (SSE / 토글 / 프로젝트 전환의 initFavorites 등)
// spotlight 의 cache.favorites 도 동기화. fetch 는 viewer 의 persist POST 와 race
// condition 있어서 stale → viewer 의 in-memory favorites 배열을 직접 복사.
// (favorites.js 의 initFavorites 도 끝에서 이 이벤트를 fire 하므로 프로젝트 전환이
// 자동 커버됨 — 별도 project-changed 리스너 불필요.)
window.addEventListener("pv:favorites-changed", () => {
    cache.favorites = viewerFavorites.slice();
});

// viewer 통합 모드: 항상 표시. 미로그인 시 사용자가 상태바 클릭으로 로그인.
spotlight.classList.remove("hidden");
loadBalance();
