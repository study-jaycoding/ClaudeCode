# 프로젝트 매니저

프로젝트 폴더를 만들고 웹 UI 로 확인하는 간단한 도구. Python 표준 라이브러리만 사용 (외부 패키지 설치 불필요).

## 폴더 구조

```
project-manager/
├── backend/
│   └── server.py        # HTTP 서버 (API + 정적 파일 서빙)
├── frontend/
│   ├── index.html       # 메인 UI
│   ├── style.css        # 스타일
│   └── app.js           # 클라이언트 로직
├── start.bat            # Windows 더블클릭 실행 스크립트
└── README.md

../projects/             # 생성된 프로젝트가 들어가는 곳
```

## 실행 방법

### Windows

`start.bat` 더블클릭, 또는 PowerShell 에서:

```powershell
cd d:\ClaudeCode\project-manager\backend
python server.py
```

서버가 시작되면 브라우저에서 <http://127.0.0.1:8765> 접속.

### 종료

콘솔에서 `Ctrl+C`.

## 사용법

1. 입력창에 프로젝트 이름 입력 → "생성" 버튼 클릭
2. `d:\ClaudeCode\projects\<이름>\` 폴더가 생기고 기본 `README.md` 가 함께 만들어진다
3. "프로젝트 목록" 섹션에서 생성된 프로젝트가 보임

## 이름 규칙

- 한글 / 영문 / 숫자 / 공백 / 하이픈 / 언더스코어
- 1 ~ 50 자
- 중복 불가

## API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/projects` | 프로젝트 목록 JSON |
| POST | `/api/projects` | `{"name": "..."}` 로 새 프로젝트 생성 |

## 백/프 분리 원칙

- `backend/` 는 Python 서버 코드만, `frontend/` 는 정적 자산만 둔다
- 백엔드는 `/api/*` 경로만 책임지고, 그 외 GET 은 `frontend/` 에서 정적 파일을 찾아 서빙
- 나중에 React/Vue 같은 프레임워크로 옮기고 싶다면 `frontend/` 만 갈아끼우면 된다
