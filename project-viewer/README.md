# 프로젝트 뷰어

`project-manager` 가 만든 프로젝트 폴더 안의 **이미지/영상/텍스트** 를 웹 브라우저에서 미리보기할 수 있는 도구. Python 표준 라이브러리만 사용 (외부 패키지 설치 불필요).

## 폴더 구조

```
project-viewer/
├── backend/
│   └── server.py        # HTTP 서버 (API + 정적 파일 서빙)
├── frontend/
│   ├── index.html       # 메인 UI (좌측 트리 + 우측 미리보기)
│   ├── style.css
│   └── app.js
├── start.bat            # Windows 더블클릭 실행 스크립트
└── README.md

D:\ClaudeCode-data\projects\   # 탐색 대상 (project-manager 와 공유하는 폴더, git repo 바깥)
```

## 실행 방법

### Windows

`start.bat` 더블클릭, 또는 PowerShell 에서:

```powershell
cd d:\ClaudeCode\project-viewer\backend
python server.py
```

브라우저에서 <http://127.0.0.1:8766> 접속.

### 종료

콘솔에서 `Ctrl+C`.

## 사용법

1. 상단 드롭다운에서 보고 싶은 프로젝트를 선택
2. 좌측 트리에서 파일을 클릭
3. 우측 미리보기 영역에 자동 표시
   - 🖼️ 이미지: `<img>` 로 표시
   - 🎬 영상: `<video controls>` 로 재생 (Range 요청 지원으로 seek 가능)
   - 📄 텍스트: 코드 하이라이트 없이 모노스페이스 폰트로 표시
   - 📦 그 외: "지원하지 않음" 안내

## 지원 확장자

| 종류 | 확장자 |
|---|---|
| 이미지 | png, jpg, jpeg, gif, webp, svg, bmp, ico |
| 영상 | mp4, webm, mov, mkv, avi, m4v *(mp4/webm 외에는 브라우저에 따라 재생 불가할 수 있음)* |
| 텍스트 | txt, md, json, py, js, ts, jsx, tsx, html, css, scss, log, yaml, yml, ini, conf, csv, xml, bat, sh, ps1, .gitignore, .env |

## API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/projects` | 프로젝트 목록 JSON |
| GET | `/api/tree?project=NAME` | 트리 구조 JSON |
| GET | `/api/file?project=NAME&path=REL` | 텍스트 파일 내용 JSON (최대 1MB) |
| GET | `/media?project=NAME&path=REL` | 이미지/영상 바이너리 (Range 지원) |

## 백/프 분리 원칙

- 백엔드는 `backend/` 안에서 완결. 프론트엔드는 `frontend/` 안에 정적 자산만.
- 백엔드는 `/api/*` 와 `/media` 만 API 로 응답하고, 그 외 GET 은 `frontend/` 의 정적 파일을 서빙한다.
- 같은 origin 이므로 CORS 설정이 필요 없다.

## 보안 메모

- 모든 GET 요청. 파일 시스템을 수정하지 않는다.
- 경로 탈출(`..`, 절대경로 우회) 시도는 모두 차단.
- 텍스트는 최대 1MB 까지만 응답 (잘림 표시).
- 로컬(127.0.0.1) 바인딩만 한다.
