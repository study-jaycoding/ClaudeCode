// 참조 객체(ref) 의 형식과 URL/이름 헬퍼.
// 세 가지 형태 지원:
//   1. 즐겨찾기:      { id, project, path, tags, ... }
//   2. 직접 URL:      { directUrl, name }
//   3. 업로드 파일:    { uploadPath, name, localThumb }

export function mediaUrl(ref) {
    if (ref.directUrl) return ref.directUrl;
    if (ref.localThumb) return ref.localThumb;
    return `/media?project=${encodeURIComponent(ref.project)}&path=${encodeURIComponent(ref.path)}`;
}

// 카드/미리보기용 작은 썸네일 — 서버가 사전 생성·디스크 캐시.
// 원본 디코드 피함 (28MB PNG → 30KB JPG). favorite 가 아닌 (directUrl/uploadPath)
// 케이스는 fallback 으로 mediaUrl.
//
// cache buster v= : 같은 path 의 새 favorite 가 옛 favorite 의 브라우저 캐시
// (이전 immutable 응답) 와 격리되도록. backend 는 v 파라미터 무시.
export function thumbUrl(ref) {
    if (ref.directUrl) return ref.directUrl;
    if (ref.localThumb) return ref.localThumb;
    const v = ref.addedAt || ref.id || "";
    const base = `/thumb?project=${encodeURIComponent(ref.project)}&path=${encodeURIComponent(ref.path)}`;
    return v ? `${base}&v=${v}` : base;
}

// 백엔드 generate 에 전달할 URL.
// 업로드 파일은 로컬 절대경로(uploadPath) 전달, 직접 URL 은 원본, 즐겨찾기는 /media URL.
export function refUrl(ref) {
    if (ref.directUrl) return ref.directUrl;
    if (ref.uploadPath) return ref.uploadPath;
    return `/media?project=${encodeURIComponent(ref.project)}&path=${encodeURIComponent(ref.path)}`;
}

export function favName(ref) {
    if (ref.name) return ref.name;
    const full = ref.path.split("/").pop();
    const dot = full.lastIndexOf(".");
    return dot > 0 ? full.substring(0, dot) : full;
}

export function favKey(ref) {
    if (ref.directUrl) return ref.directUrl;
    if (ref.uploadPath) return ref.uploadPath;
    return `${ref.project}/${ref.path}`;
}
