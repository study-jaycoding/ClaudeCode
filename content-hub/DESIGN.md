# Content Hub — 설계 명세

Higgsfield CLI 기반 콘텐츠 생성·공유 툴의 상세 설계.
규칙·스택은 CLAUDE.md 참조. 이 문서는 "무엇을 어떻게 만드는가"를 정의한다.

---

## 1. 시스템 아키텍처

3층 구조이며, 핵심은 **로컬 우선 + 선택적 발행**이다.

### 개인 워크스테이션 (로컬)
- **React UI** — 썸네일 그리드, 필터, 재생성. 모든 탐색은 로컬에서 즉시.
- **FastAPI 백엔드** — 비동기 API, WebSocket 진행률 푸시.
- **SQLite (WAL)** — 내 메타데이터(생성 기록, 태그, 컬러 등).
- **CLI 브리지** — `higgsfield` CLI를 asyncio subprocess로 호출.
- **로컬 파일 캐시** — 썸네일·레퍼런스·결과물 원본.

### Higgsfield 클라우드
- 실제 생성 엔진. CLI를 통해 호출하고 결과를 수신한다.

### 팀 공유 서버 (Phase 5)
- **FastAPI** — 발행(publish) API.
- **PostgreSQL** — 공유 메타데이터.
- **MinIO (S3 호환)** — 공유된 에셋 저장.

데이터 흐름:
- 로컬 ↔ Higgsfield: CLI 호출 / 결과 수신.
- 로컬 ↔ 공유 서버: 발행 시 메타+에셋 push, 가져올 때 pull 후 로컬로 복제.

---

## 2. 데이터 모델

### 엔티티
- **worker** — 작업자(개인/팀 계정 구분)
- **generation** — 생성 기록(프롬프트, 모델, 파라미터, 컬러, 상태)
- **asset** — 생성 결과물(이미지/영상 + 썸네일)
- **reference** — 생성에 쓰인 레퍼런스(이미지/영상 + 썸네일)
- **gen_reference** — generation↔reference 다대다 연결. `role`에 @Image/@Video 슬롯 저장
- **tag** / **gen_tag** — 태그와 다대다 연결
- **share** — 발행 기록(누가, 언제, 공개 범위)
- **lineage** — 재활용 계보(parent_gen → child_gen)

### 핵심 관계
- reference는 `gen_reference`를 통해 여러 generation에서 재사용된다.
- 공유받은 콘텐츠를 가져와 재생성하면 `lineage`에 부모-자식 관계가 남는다.
- 한 generation은 0~1개의 share를 가진다(발행 여부).

### SQLite DDL (schema.sql 로 바로 사용 가능)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE worker (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'personal'   -- 'personal' | 'team'
);

CREATE TABLE generation (
    id         TEXT PRIMARY KEY,
    worker_id  TEXT NOT NULL REFERENCES worker(id),
    prompt     TEXT NOT NULL,
    model      TEXT,
    params     TEXT,                                 -- JSON 문자열
    color      TEXT,                                 -- 컬러 마커 (hex/name)
    status     TEXT NOT NULL DEFAULT 'pending',      -- pending|running|done|failed
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE asset (
    id             TEXT PRIMARY KEY,
    generation_id  TEXT NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
    type           TEXT NOT NULL,                    -- 'image' | 'video'
    file_path      TEXT NOT NULL,
    thumbnail_path TEXT
);

CREATE TABLE reference (
    id             TEXT PRIMARY KEY,
    type           TEXT NOT NULL,                    -- 'image' | 'video'
    file_path      TEXT NOT NULL,
    thumbnail_path TEXT,
    source         TEXT                              -- 'uploaded' | 'from_generation'
);

CREATE TABLE gen_reference (
    generation_id TEXT NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
    reference_id  TEXT NOT NULL REFERENCES reference(id),
    role          TEXT,                              -- '@Image1', '@Video' 등 슬롯
    PRIMARY KEY (generation_id, reference_id, role)
);

CREATE TABLE tag (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE gen_tag (
    generation_id TEXT NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
    tag_id        TEXT NOT NULL REFERENCES tag(id),
    PRIMARY KEY (generation_id, tag_id)
);

CREATE TABLE share (
    id            TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES generation(id),
    shared_by     TEXT NOT NULL REFERENCES worker(id),
    visibility    TEXT NOT NULL DEFAULT 'team',
    shared_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lineage (
    id            TEXT PRIMARY KEY,
    parent_gen_id TEXT NOT NULL REFERENCES generation(id),
    child_gen_id  TEXT NOT NULL REFERENCES generation(id)
);

CREATE INDEX idx_generation_worker  ON generation(worker_id);
CREATE INDEX idx_generation_created ON generation(created_at);
CREATE INDEX idx_asset_generation   ON asset(generation_id);
CREATE INDEX idx_genref_gen         ON gen_reference(generation_id);
CREATE INDEX idx_gentag_gen         ON gen_tag(generation_id);
CREATE INDEX idx_lineage_parent     ON lineage(parent_gen_id);
CREATE INDEX idx_lineage_child      ON lineage(child_gen_id);
```

---

## 3. 처리 흐름

1. 사용자가 **프롬프트 + 레퍼런스**를 입력한다 (작업 시작).
2. **CLI 비동기 호출** — 생성 잡을 큐에 등록한다.
3. **생성 진행** — WebSocket으로 진행률을 UI에 푸시한다.
4. **결과 저장 · DB 기록** — 결과물/썸네일을 로컬 캐시에 저장하고, generation·asset 레코드를 만든다. 사용자가 태그·컬러를 부여한다.
5. **공유 분기**
   - 아니오 → 로컬 워크스페이스에만 보관(끝).
   - 예 → **공유 서버에 발행**. 메타데이터 + 에셋을 push하고 share 레코드 생성.
6. **팀원 가져오기 · 재활용** — 다른 사람이 공유 갤러리에서 가져와 프롬프트·레퍼런스를 로컬로 복제한다.
7. 복제본으로 **새 생성** 시 1번으로 순환하며, `lineage`에 부모-자식 관계를 기록한다.

---

## 4. UI 명세 (메인 화면)

### 상단 바
- 로고 + 앱 이름 "Content Hub"
- 검색 입력 (프롬프트·태그 검색)
- `+ 새 생성` 버튼 → 생성 모달 오픈

### 탭
- **내 작업** (로컬 생성물) / **팀 공유** (공유받은 콘텐츠)

### 좌측 필터 사이드바 (~150px)
- **컬러** — 컬러 마커 점들로 필터
- **태그** — 태그 칩
- **작업자** — 작업자 목록
- **상태** — "공유한 것만" 토글

### 메인 썸네일 그리드
- `grid auto-fit minmax(150px, 1fr)`
- 카드 구성: 썸네일(좌상단 컬러 마커, 우상단 타입 배지 이미지/영상), 프롬프트 1줄 요약, 태그 칩, 작업자 아바타, 액션 버튼(재생성 ↻ / 공유 ↗)

### 생성 모달 (별도)
- 프롬프트 입력 (textarea)
- 레퍼런스 드롭존 (@Image/@Video 슬롯)
- 모델 선택 (Seedance / Soul / Nano Banana 등)
- 생성 시작 → 진행률 표시

### 팀 공유 탭
- 공유받은 콘텐츠 갤러리
- 카드마다 `내 워크스페이스로 가져오기` 버튼 → 로컬 복제 + lineage 기록

---

## 5. 단계별 개발 로드맵
1. **Phase 1** — schema.sql + db.py (SQLite 초기화, WAL)
2. **Phase 2** — FastAPI 골격 + 라이브러리 조회 라우터 (로컬 탐색·필터)
3. **Phase 3** — cli_bridge.py + 잡 큐 + WebSocket 진행률 (생성 파이프라인)
   - ⚠️ Phase 3 착수 전: 실제 `higgsfield generate list --json` 출력으로 필드 매핑 검증 필요
4. **Phase 4** — React UI (썸네일 그리드 / 필터 / 생성 모달)
5. **Phase 5** — publish/import 엔드포인트 + 공유 서버(PostgreSQL + MinIO)
