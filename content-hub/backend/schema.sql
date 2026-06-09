-- Content Hub — 로컬 SQLite 스키마 (Phase 1)
-- 설계 근거: DESIGN.md §2 데이터 모델
-- 적용:  sqlite3 content_hub.db < backend/schema.sql
--        또는 app.db.init_db() 로 자동 적용
--
-- 주의: journal_mode = WAL 은 DB 파일에 영속적으로 기록되는 설정이라
--        스키마와 함께 선언해 둔다. foreign_keys 는 연결마다 다시 켜야 하므로
--        db.py 의 커넥션 팩토리에서도 PRAGMA foreign_keys = ON 을 반복 적용한다.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 작업자(개인/팀 계정 구분)
CREATE TABLE IF NOT EXISTS worker (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'personal'   -- 'personal' | 'team'
);

-- 생성 기록(프롬프트, 모델, 파라미터, 컬러, 상태)
CREATE TABLE IF NOT EXISTS generation (
    id         TEXT PRIMARY KEY,
    worker_id  TEXT NOT NULL REFERENCES worker(id),
    prompt     TEXT NOT NULL,
    model      TEXT,
    params     TEXT,                                 -- JSON 문자열
    color      TEXT,                                 -- 컬러 마커 (hex/name)
    status     TEXT NOT NULL DEFAULT 'pending',      -- pending|running|done|failed
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 생성 결과물(이미지/영상 + 썸네일)
CREATE TABLE IF NOT EXISTS asset (
    id             TEXT PRIMARY KEY,
    generation_id  TEXT NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
    type           TEXT NOT NULL,                    -- 'image' | 'video'
    file_path      TEXT NOT NULL,
    thumbnail_path TEXT
);

-- 생성에 쓰인 레퍼런스(이미지/영상 + 썸네일)
CREATE TABLE IF NOT EXISTS reference (
    id             TEXT PRIMARY KEY,
    type           TEXT NOT NULL,                    -- 'image' | 'video'
    file_path      TEXT NOT NULL,
    thumbnail_path TEXT,
    source         TEXT                              -- 'uploaded' | 'from_generation'
);

-- generation ↔ reference 다대다 연결. role 에 @Image/@Video 슬롯 저장
CREATE TABLE IF NOT EXISTS gen_reference (
    generation_id TEXT NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
    reference_id  TEXT NOT NULL REFERENCES reference(id),
    role          TEXT,                              -- '@Image1', '@Video' 등 슬롯
    PRIMARY KEY (generation_id, reference_id, role)
);

-- 태그
CREATE TABLE IF NOT EXISTS tag (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

-- generation ↔ tag 다대다 연결
CREATE TABLE IF NOT EXISTS gen_tag (
    generation_id TEXT NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
    tag_id        TEXT NOT NULL REFERENCES tag(id),
    PRIMARY KEY (generation_id, tag_id)
);

-- 발행 기록(누가, 언제, 공개 범위)
CREATE TABLE IF NOT EXISTS share (
    id            TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES generation(id),
    shared_by     TEXT NOT NULL REFERENCES worker(id),
    visibility    TEXT NOT NULL DEFAULT 'team',
    shared_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 재활용 계보(parent_gen → child_gen)
CREATE TABLE IF NOT EXISTS lineage (
    id            TEXT PRIMARY KEY,
    parent_gen_id TEXT NOT NULL REFERENCES generation(id),
    child_gen_id  TEXT NOT NULL REFERENCES generation(id)
);

CREATE INDEX IF NOT EXISTS idx_generation_worker  ON generation(worker_id);
CREATE INDEX IF NOT EXISTS idx_generation_created ON generation(created_at);
CREATE INDEX IF NOT EXISTS idx_asset_generation   ON asset(generation_id);
CREATE INDEX IF NOT EXISTS idx_genref_gen         ON gen_reference(generation_id);
CREATE INDEX IF NOT EXISTS idx_gentag_gen         ON gen_tag(generation_id);
CREATE INDEX IF NOT EXISTS idx_lineage_parent     ON lineage(parent_gen_id);
CREATE INDEX IF NOT EXISTS idx_lineage_child      ON lineage(child_gen_id);
