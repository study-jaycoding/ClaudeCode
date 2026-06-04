// 공유 가변 상태. 다른 모듈은 직접 import 해서 읽고/쓴다.

import { PROJECT_KEY } from "./constants.js";

export const state = {
    type: "image",
    model: "nano_banana_2",
    ratio: "16:9",
    optionValues: {},
    repeatCount: 1,
    connected: false,
    credits: 0,
    project: (() => { try { return localStorage.getItem(PROJECT_KEY) || ""; } catch { return ""; } })(),
};

// 모델/즐겨찾기/프로젝트 캐시
export const cache = {
    allModels: [],
    models: [],         // 현재 type 으로 필터링된 목록
    favorites: [],
    projects: [],
};

// 피커 임시 상태
export const pickerState = {
    favHighlight: -1,
    filteredFavs: [],
    tagFilter: null,
    tagHighlight: -1,
    filteredTags: [],
};

export function getModel(id) {
    return cache.models.find((m) => m.id === id);
}
