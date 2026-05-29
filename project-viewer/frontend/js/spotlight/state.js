// 공유 가변 상태. 다른 모듈은 직접 import 해서 읽고/쓴다.

import { PROJECT_KEY } from "./constants.js";
import { currentProject as viewerCurrentProject } from "../state.js";

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

// viewer 의 "소스" 탭과 동일한 조건: 사용자가 명시적으로 소스 토글한 항목 중
// Result/ (자동 생성물) 이 아닌 것.
export function isSourceFav(f) {
    return f && f.isSource === true && !String(f.path || "").startsWith("Result/");
}

// @ 피커 / 태그 필터가 검색하는 집합:
// viewer 에서 선택된 프로젝트의 소스만. 프로젝트 미선택 시 빈 배열.
export function sourceFavorites() {
    if (!viewerCurrentProject) return [];
    return cache.favorites.filter((f) => f.project === viewerCurrentProject && isSourceFav(f));
}
