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
export const projectDropdown = $("project-dropdown");

export const projectBtn = $("project-btn");
export const projectValue = $("project-value");

export const genBtn = $("gen-btn");
export const results = $("results");
export const resultsGrid = $("results-grid");
export const resultsToggle = $("results-toggle");
export const resultsToggleIcon = $("results-toggle-icon");
export const resultsUnseen = $("results-unseen");

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
