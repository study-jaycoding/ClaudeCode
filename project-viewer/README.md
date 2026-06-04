# Project Viewer

브라우저에서 프로젝트 폴더의 이미지/영상/텍스트를 미리보고, 즐겨찾기·태그·드래그앤드롭 업로드까지 관리하는 로컬 도구. Higgsfield Spotlight 와 같은 `CCDATA_DIR` 을 보면 생성 결과가 자동으로 트리에 반영된다.

> **처음 쓰는 분은 [USAGE.md (사용법 가이드)](USAGE.md) 부터 읽으세요.**
> 이 README 는 설치·배포·환경 설정 위주입니다.

## 빠른 시작

```cmd
install.bat        :: 최초 1회 — Python 체크 + .env 생성
start.bat          :: 매일 — 서버 시작 (포트 8766)
update.bat         :: 가끔 — git pull + 안내
```

브라우저에서 <http://127.0.0.1:8766> 접속.

## 사전 요구사항

- **Python 3.10+** — <https://python.org>
- (선택) **Higgsfield Spotlight** — 생성 통합 시 [`../higgsfield-spotlight/`](../higgsfield-spotlight/) 같이 설치

## 설정 (`.env`)

`install.bat` 가 `.env.example` 을 `.env` 로 복사한다. 필요한 항목만 편집:

| 키 | 기본값 | 설명 |
|---|---|---|
| `CCDATA_DIR` | `D:/ClaudeCode-data` | 프로젝트·favorites 의 부모 디렉토리 |
| `CCDATA_PROJECTS_DIR` | `<CCDATA_DIR>/projects` | 분리 override |
| `CCDATA_FAVORITES_FILE` | `<CCDATA_DIR>/favorites.json` | 분리 override |
| `PV_PORT` | `8766` | listen 포트 |
| `PV_BIND` | `127.0.0.1` | listen 주소 (LAN 노출은 `0.0.0.0`) |
| `PV_EXTRA_ORIGINS` | (빈 값) | 같은 origin 외 허용할 origin (콤마 구분) |
| `PV_EXTRA_HOSTS` | (빈 값) | 같은 origin 외 허용할 host (콤마 구분) |
| `PV_MAX_UPLOAD_MB` | `500` | 업로드 최대 크기 (MB) |

## 팀 공유 — 추천: 하이브리드 (서버 1대 + 각자 spotlight)

50명 규모 팀은 다음 구조가 가장 안전·편리합니다:

```
                ┌─────────────────────────────────┐
                │  팀 서버 1대                    │
                │  ┌──────────────────────────┐   │
                │  │ PV (Python 실행 중)      │   │
                │  │ http://server:8766       │   │
                │  └──────────────────────────┘   │
                │  ┌──────────────────────────┐   │
                │  │ team-data/projects/      │   │
                │  │ team-data/favorites.json │   │
                │  └──────────────────────────┘   │
                └─────────────────────────────────┘
                          ↑↓ LAN
   ┌──────────┐    ┌──────────┐    ┌──────────┐
   │ 사용자 A │    │ 사용자 B │    │ 사용자 C │
   │ 브라우저 │    │ 브라우저 │    │ 브라우저 │
   │+spotlight│    │+spotlight│    │+spotlight│
   │(자기계정)│    │(자기계정)│    │(자기계정)│
   └──────────┘    └──────────┘    └──────────┘
```

- **PV 는 서버 1대에서만 실행** — 모두가 같은 트리·즐겨찾기 보며 협업
- **Spotlight 는 각 PC 에서 실행** — 각자 자기 Higgsfield 계정으로 생성, credit 분리
- 생성 결과는 NAS 에 자동 저장 → 모두의 PV 에 즉시 반영

### 서버 1대 설정

```env
# 서버의 .env
PV_BIND=0.0.0.0
PV_EXTRA_ORIGINS=http://192.168.1.10:8766,http://pv.company.local:8766
PV_EXTRA_HOSTS=192.168.1.10:8766,pv.company.local:8766
CCDATA_DIR=//nas/team-data
```

`start.bat` 실행 → 다른 PC 가 `http://192.168.1.10:8766` 접속.

### 각 사용자 PC 설정 (Spotlight 만)

[higgsfield-spotlight](../higgsfield-spotlight/) 를 각자 자기 PC 에 설치하고 `.env` 의 `CCDATA_DIR` 만 같은 NAS 경로로:

```env
CCDATA_DIR=//nas/team-data
```

그리고 자기 계정으로 `higgsfield auth login`.

### 모두 자기 PC 에서 실행 (대안)

서버 운영이 어려우면 PV 도 각자 자기 PC 에 설치하고 `CCDATA_DIR` 만 공유:

```env
CCDATA_DIR=Z:/team-data
```

- 장점: 서버 의존성 0, 설치 간단
- 단점: 각자 Python 설치 필요. 50명 규모면 하이브리드가 더 깔끔

## 동시 작업 안전성

favorites.json 은 단일 파일이지만 **cross-process file lock** 으로 보호됩니다 (`<CCDATA_DIR>/favorites.json.lock`):

- PV 서버의 thread 들 사이: 직렬화 ✓
- PV 서버와 각 사용자의 spotlight 사이: cross-process lock 으로 직렬화 ✓
- 여러 사용자가 동시 즐겨찾기 토글 / 생성 결과 자동 등록 — 모두 안전

생성 메타데이터는 [entry-per-file 구조](#-생성-메타데이터)로 본질적으로 race-free.

### NAS 선택
- **SMB (Synology/QNAP/Windows Share)** — 권장. file lock 잘 작동
- **NFS** — 락 신뢰도 낮음. 비추
- **클라우드 동기화 (Dropbox/OneDrive)** — sync 충돌 사본 만들어짐. 비추

### Windows 260자 path 제한
한글 폴더 + 긴 파일명 시 `\\?\` prefix 또는 Win10+ long-path 옵션 켜기.

## 폴더 구조

```
project-viewer/
├── backend/
│   ├── server.py             # HTTP 서버 (PV + spotlight 라우팅)
│   └── spotlight/            # 임베디드 spotlight 모듈
├── frontend/
│   ├── index.html
│   ├── js/                   # ES Module 17개
│   └── style*.css
├── .env.example              # 설정 템플릿
├── install.bat / update.bat / start.bat
└── README.md

<CCDATA_DIR>/projects/        # 프로젝트 폴더 (repo 바깥)
<CCDATA_DIR>/favorites.json   # 공유 favorites
```

## 지원 확장자

| 종류 | 확장자 |
|---|---|
| 이미지 | png, jpg, jpeg, gif, webp, svg, bmp, ico |
| 영상 | mp4, webm, mov, mkv, avi, m4v |
| 텍스트 | txt, md, json, py, js, ts, jsx, tsx, html, css, scss, log, yaml, yml, ini, conf, csv, xml, bat, sh, ps1, .gitignore, .env |

## 주요 단축키

| 키 | 동작 |
|---|---|
| `F2` | 단일 선택 이름 변경 (인라인) |
| `Delete` | 선택 항목 삭제 (다중 가능) |
| `Enter` | 단일 선택 열기 (폴더 진입 / 이미지·비디오 라이트박스) |
| `Esc` | 라이트박스 닫기 / 선택 해제 |
| `Ctrl+A` | 그리드 전체 선택 |
| `Ctrl+Z` | 마지막 작업 되돌리기 (이동·이름변경·태그·마커) |
| `Ctrl+Shift+N` | 현재 폴더에 새 폴더 |

## API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/projects` | 프로젝트 목록 |
| GET | `/api/tree?project=NAME` | 트리 구조 |
| GET | `/api/file?project=NAME&path=REL` | 텍스트 파일 (최대 1MB) |
| GET | `/api/favorites` | 즐겨찾기 전체 |
| POST | `/api/favorites` | 즐겨찾기 통째 덮어쓰기 |
| GET | `/api/events` | SSE — favorites.json 변경 알림 |
| GET | `/media?project=NAME&path=REL` | 이미지/영상 (Range 지원) |
| POST | `/api/upload` | 드래그 업로드 |
| POST | `/api/move`, `/api/rename`, `/api/delete`, `/api/reveal`, `/api/folder` | 파일 조작 |

## 보안 메모

- 기본 bind 는 `127.0.0.1` (로컬만). LAN 노출은 명시적으로 `PV_BIND=0.0.0.0` 설정 필요
- LAN 노출 시 인증 없음 — 신뢰된 사내망에서만 사용
- 경로 탈출 시도(`..`, 절대경로 우회) 차단
- 업로드 / 파일 조작은 same-origin 요청만 허용 (Host / Sec-Fetch-Site 체크)
