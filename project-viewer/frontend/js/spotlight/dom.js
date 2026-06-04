// 모든 DOM 요소 참조를 한 곳에서 export.

const $ = (id) => document.getElementById(id);

export const spotlight = $("spotlight");
export const backdrop = $("backdrop");
export const panelEl = $("panel");
export const promptInput = $("prompt-input");
export const promptRowEl = $("prompt-row");
export const addRefBtn = $("add-ref-btn");

export const modelBtn = $("model-btn");
export const modelName = $("model-name");
export const providerDot = $("provider-dot");
export const ratioBtn = $("ratio-btn");
export const ratioValue = $("ratio-value");
export const dynamicOpts = $("dynamic-opts");

export const modelDropdown = $("model-dropdown");
export const ratioDropdown = $("ratio-dropdown");

export const genBtn = $("gen-btn");
// 결과 영역은 폐기됨 — viewer 사이드바 "큐" 탭에서 진행/이력 확인.
// 호환을 위한 null stub (다른 모듈이 import 해도 폭주하지 않게).
export const results = null;
export const resultsGrid = null;
export const resultsToggle = null;
export const resultsToggleIcon = null;
export const resultsUnseen = null;

export const statusIndicator = $("status-indicator");
export const statusText = $("status-text");
export const statusCredits = $("status-credits");
export const statusBar = $("status-bar");

export const lightbox = $("sp-lightbox");
export const lightboxBody = $("sp-lightbox-body");
export const lightboxClose = $("sp-lightbox-close");

export const favPicker = $("fav-picker");
export const favList = $("fav-list");
export const favEmpty = $("fav-empty");

export const tagPicker = $("tag-picker");
export const tagList = $("tag-list");
export const tagEmpty = $("tag-empty");
export const tagFilterBadge = $("tag-filter-badge");
export const tfbName = $("tfb-name");
export const tfbClear = $("tfb-clear");
export const tagActiveBadge = $("tag-active-badge");
export const tabName = $("tab-name");
export const tabClear = $("tab-clear");
