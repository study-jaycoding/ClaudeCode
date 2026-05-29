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
