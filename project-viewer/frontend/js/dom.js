// =====================================================================
// DOM element 참조 — module 이라 deferred 실행, 안전하게 즉시 query 가능
// =====================================================================

export const projectSelect = document.getElementById("project-select");
export const refreshBtn = document.getElementById("refresh-btn");
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
export const genTree = document.getElementById("gen-tree");

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
