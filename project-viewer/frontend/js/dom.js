// =====================================================================
// DOM element 참조 — module 이라 deferred 실행, 안전하게 즉시 query 가능
// =====================================================================

export const projectSelect = document.getElementById("project-select");
export const fileTree = document.getElementById("file-tree");
export const previewInfo = document.getElementById("preview-info");
export const previewContent = document.getElementById("preview-content");
export const previewSection = document.querySelector("section.preview");

export const dropOverlay = document.getElementById("drop-overlay");
export const dropTargetEl = document.getElementById("drop-target");

export const favoritesList = document.getElementById("favorites-list");
export const favCountEl = document.getElementById("fav-count");
export const genCountEl = document.getElementById("gen-count");
export const tagFilterBar = document.getElementById("tag-filter-bar");

export const tabBtns = document.querySelectorAll(".tab-btn");
export const tabTree = document.getElementById("tab-tree");
export const tabFavorites = document.getElementById("tab-favorites");
export const tabGenerated = document.getElementById("tab-generated");
export const tabViewer = document.getElementById("tab-viewer");
export const genTree = document.getElementById("gen-tree");

// 보기 탭 — 트랙 / 플레이어 / picker 모달
export const viewerTrackList = document.getElementById("viewer-track-list");
export const viewerAddBtn = document.getElementById("viewer-add-btn");
export const viewerClearBtn = document.getElementById("viewer-clear-btn");
export const viewerTrackTotal = document.getElementById("viewer-track-total");
export const viewerStage = document.getElementById("viewer-stage");
export const viewerScreen = document.getElementById("viewer-screen");
export const viewerScreenEmpty = document.getElementById("viewer-screen-empty");
export const viewerV0 = document.getElementById("viewer-v0");
export const viewerV1 = document.getElementById("viewer-v1");
export const viewerImg = document.getElementById("viewer-img");
export const viewerPlayBtn = document.getElementById("viewer-play-btn");
export const viewerPrevBtn = document.getElementById("viewer-prev-btn");
export const viewerNextBtn = document.getElementById("viewer-next-btn");
export const viewerTimeCur = document.getElementById("viewer-time-cur");
export const viewerTimeTotal = document.getElementById("viewer-time-total");
export const viewerClipLabel = document.getElementById("viewer-clip-label");
export const viewerTimeline = document.getElementById("viewer-timeline");
export const viewerScrubbar = document.getElementById("viewer-scrubbar");
export const viewerScrubbarFill = document.getElementById("viewer-scrubbar-fill");
export const viewerScrubbarHead = document.getElementById("viewer-scrubbar-head");
export const viewerLoopBtn = document.getElementById("viewer-loop-btn");
export const viewerVolBtn = document.getElementById("viewer-vol-btn");
export const viewerVolSlider = document.getElementById("viewer-vol-slider");
export const viewerFsBtn = document.getElementById("viewer-fs-btn");
export const viewerPicker = document.getElementById("viewer-picker");
export const viewerPickerTree = document.getElementById("viewer-picker-tree");
export const viewerPickerGrid = document.getElementById("viewer-picker-grid");
export const viewerPickerClose = document.getElementById("viewer-picker-close");
export const viewerPickerBc = document.getElementById("viewer-picker-bc");
export const viewerPickerAdded = document.getElementById("viewer-picker-added");
export const viewerPickerSort = document.getElementById("viewer-picker-sort");
export const viewerPickerSortDir = document.getElementById("viewer-picker-sort-dir");
export const viewerPickerKind = document.getElementById("viewer-picker-kind");
export const viewerPickerColor = document.getElementById("viewer-picker-color");

export const lightbox = document.getElementById("lightbox");
export const lightboxStage = document.getElementById("lightbox-stage");
export const lightboxCaption = document.getElementById("lightbox-caption");
export const lightboxClose = document.querySelector(".lightbox-close");

export const contextPopup = document.getElementById("context-popup");
export const treeMenu = document.getElementById("tree-menu");
export const lasso = document.getElementById("lasso");

export const cardSizeSlider = document.getElementById("card-size-slider");
export const cardSizeValueEl = document.getElementById("card-size-value");
export const viewBtns = document.querySelectorAll(".view-toggle .view-btn");
export const sortSelect = document.getElementById("sort-select");
export const sortDirBtn = document.getElementById("sort-dir-btn");
