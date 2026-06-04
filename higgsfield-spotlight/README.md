# Higgsfield Spotlight

Higgsfield CLI 를 감싸서 브라우저 UI 로 이미지/영상을 생성하는 로컬 도구. Project Viewer 와 같은 `CCDATA_DIR` 을 보면 생성 결과가 PV 의 생성탭에 자동 반영된다.

## 빠른 시작

```cmd
install.bat        :: 최초 1회 — Python/npm/CLI 체크 + .env 생성
start.bat          :: 매일 — 서버 시작 (포트 8767)
update.bat         :: 가끔 — git pull + CLI 업데이트
```

브라우저에서 <http://127.0.0.1:8767> 접속.

## 사전 요구사항

- **Python 3.10+** — <https://python.org>
- **Node.js + npm** — <https://nodejs.org>
- **Higgsfield CLI** — `npm install -g @higgsfield/cli` (install.bat 가 자동 설치)
- **로그인** — `higgsfield auth login` (브라우저로 이동)

## 설정 (`.env`)

`install.bat` 가 `.env.example` 을 `.env` 로 복사한다.

| 키 | 기본값 | 설명 |
|---|---|---|
| `CCDATA_DIR` | `D:/ClaudeCode-data` | PV 와 동일하게 설정 |
| `CCDATA_PROJECTS_DIR` | `<CCDATA_DIR>/projects` | 분리 override |
| `CCDATA_FAVORITES_FILE` | `<CCDATA_DIR>/favorites.json` | 분리 override |
| `SPOTLIGHT_PORT` | `8767` | listen 포트 |
| `SPOTLIGHT_BIND` | `127.0.0.1` | listen 주소 |
| `SPOTLIGHT_EXTRA_ORIGINS` | (빈 값) | 추가 허용 origin |
| `SPOTLIGHT_EXTRA_HOSTS` | (빈 값) | 추가 허용 host |
| `SPOTLIGHT_MAX_UPLOAD_MB` | `20` | 업로드 최대 크기 (MB) |

## 팀 공유 (각자 자기 계정)

Higgsfield CLI 는 single-account 구조라 한 서버에서 여러 계정을 동시에 못 쓴다. 그래서 **각자 자기 PC 에 spotlight 설치 + 자기 계정으로 로그인**하는 패턴이 안전:

```
PC A 사용자 A: 자기 계정 로그인 → 자기 credit 으로 생성 → CCDATA_DIR (공유 NAS) 에 저장
PC B 사용자 B: 자기 계정 로그인 → 자기 credit 으로 생성 → 같은 NAS 에 저장
PC C ...
```

생성 결과는 모두 같은 NAS 에 떨어지고, PV 의 SSE 가 자동 갱신하므로 모두가 즉시 볼 수 있다.

## 생성 흐름

1. 프롬프트 입력 + (선택) @ 로 reference 이미지/영상 첨부
2. 📁 chip 으로 결과 저장 프로젝트 선택
3. Generate 클릭
4. **이미지** — CLI `--wait` 안에 완료되면 즉시 다운로드 + favorites 등록
5. **영상** — CLI 가 timeout 으로 일찍 끝나면 client 가 polling → 완료 후 `/api/save` 호출 → 다운로드 + favorites 등록

## 모델별 옵션

`higgsfield model get <id>` 로 검증된 catalog 사용:
- `duration` enum 모델: veo3_1, kling2_6, minimax_hailuo, wan2_6, seedance1_5
- `duration` range 모델: seedance_2_0, kling3_0, grok_video, cinematic_studio_3_0, cinematic_studio_video_v2, wan2_7
- `aspect_ratio` 없는 모델: minimax_hailuo (UI 자동 숨김)
- 이미지 ref 필수: veo3 (generate 클릭 시 ref 0 이면 차단)

## API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/models` | 모델 카탈로그 |
| GET | `/api/projects` | 프로젝트 목록 |
| GET | `/api/balance` | credit 잔액 |
| GET | `/api/favorites` | 이미지 즐겨찾기 (ref picker 용) |
| GET | `/api/jobs/<id>` | job 상태 (polling) |
| POST | `/api/login` | 브라우저 로그인 트리거 |
| POST | `/api/upload` | 외부 이미지 업로드 (CLI 가 자동 업로드) |
| POST | `/api/generate` | 생성 요청 |
| POST | `/api/save` | polling 으로 받은 결과를 프로젝트로 다운로드 |
| GET | `/pv-media?project=NAME&path=REL` | PV 폴더의 이미지/영상 fetch |

## 디렉토리 구조

```
higgsfield-spotlight/
├── backend/
│   ├── server.py             # HTTP 서버
│   ├── config.py             # 환경변수 읽기
│   ├── api.py                # 엔드포인트
│   ├── catalog.py            # 모델 카탈로그
│   ├── cli.py                # higgsfield 명령 wrapper
│   ├── generation.py         # 생성 흐름
│   ├── projects.py           # 다운로드 + favorites
│   └── media.py              # /pv-media 서빙
├── frontend/
│   ├── index.html
│   └── modules/              # ES Module 18개
├── .env.example
├── install.bat / update.bat / start.bat
└── README.md
```

## 보안 메모

- 기본 bind `127.0.0.1` (로컬만)
- LAN 노출은 `SPOTLIGHT_BIND=0.0.0.0` + `SPOTLIGHT_EXTRA_HOSTS` 명시
- POST 는 same-origin 만 허용 (Host / Origin / Sec-Fetch-Site 체크)
- LAN 노출 시 인증 layer 없음 — 신뢰된 사내망에서만
