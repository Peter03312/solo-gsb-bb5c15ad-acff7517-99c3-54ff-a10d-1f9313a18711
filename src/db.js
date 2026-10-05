'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'nesting.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  fabric_width  INTEGER NOT NULL,   -- 兼容旧字段：等于首卷宽度（单卷方案即布幅宽度）
  fabric_length INTEGER NOT NULL,   -- 兼容旧字段：等于首卷长度（单卷方案即可用长度）
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft | partial | complete
  used_length   INTEGER NOT NULL DEFAULT 0,      -- 各卷实际占用长度之和
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rolls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,    -- 卷序号（1..N）
  label       TEXT NOT NULL,       -- 卷号/卷名
  width       INTEGER NOT NULL,    -- 该卷布幅宽度 mm
  length      INTEGER NOT NULL,    -- 该卷可用长度 mm
  used        INTEGER NOT NULL DEFAULT 0,        -- 是否有裁片排入（启用）
  used_length INTEGER NOT NULL DEFAULT 0,        -- 该卷实际占用长度
  cut_line    INTEGER NOT NULL DEFAULT 0         -- 本卷裁剪切线（mm）：[0,cut_line) 段已裁，不可回退；只增不减
);

CREATE TABLE IF NOT EXISTS defects (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  roll_id INTEGER REFERENCES rolls(id) ON DELETE CASCADE, -- 所属卷（旧数据迁移为首卷）
  x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS piece_models (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,             -- 型号名（改版保持不变）
  current_type_id  INTEGER NOT NULL           -- 当前纸样版本所在 piece_types.id
);

CREATE TABLE IF NOT EXISTS piece_types (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  model_id       INTEGER REFERENCES piece_models(id) ON DELETE CASCADE, -- 所属型号（改版产生新版本行）
  version        INTEGER NOT NULL DEFAULT 1,  -- 纸样版本（1=原始；每次改版 +1）
  superseded_by  INTEGER,                     -- 被哪个新版本取代（NULL=当前版本）
  name           TEXT NOT NULL,
  vertices       TEXT NOT NULL,              -- JSON，归一化后的顶点 [[x,y],...]
  quantity       INTEGER NOT NULL,           -- 该版本提交时的目标总件数
  allow_rotate   INTEGER NOT NULL DEFAULT 0, -- 是否允许旋转 180°
  bw INTEGER NOT NULL, bh INTEGER NOT NULL  -- 外接矩形尺寸（旋转 180° 不变）
);

CREATE TABLE IF NOT EXISTS placements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  model_id         INTEGER REFERENCES piece_models(id) ON DELETE CASCADE, -- 所属型号（跨纸样版本稳定）
  piece_type_id    INTEGER NOT NULL REFERENCES piece_types(id) ON DELETE CASCADE,
  roll_id          INTEGER REFERENCES rolls(id) ON DELETE CASCADE, -- 所在卷（未排入为 NULL）
  required_roll_id INTEGER REFERENCES rolls(id) ON DELETE SET NULL, -- 必用卷约束（NULL=不限）
  seq              INTEGER NOT NULL,       -- 该型号的第几件（1..quantity）
  x INTEGER, y INTEGER,                    -- 卷内放置位置（未排入为 NULL）
  rotation INTEGER NOT NULL DEFAULT 0,     -- 0 | 180
  placed   INTEGER NOT NULL DEFAULT 0,
  locked   INTEGER NOT NULL DEFAULT 0,
  cut      INTEGER NOT NULL DEFAULT 0,           -- 已裁标记（已随切线前布段裁下）：卷号/位置/方向/必用卷均不可再改
  unplaced_reason TEXT                         -- 未排入原因
);
`);

// 索引放在列迁移之后创建（旧库的 defects/placements 此时可能还没有 roll_id 列）
function ensureIndices() {
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_rolls_job       ON rolls(job_id);
CREATE INDEX IF NOT EXISTS idx_defects_job     ON defects(job_id);
CREATE INDEX IF NOT EXISTS idx_defects_roll    ON defects(roll_id);
CREATE INDEX IF NOT EXISTS idx_models_job      ON piece_models(job_id);
CREATE INDEX IF NOT EXISTS idx_types_job       ON piece_types(job_id);
CREATE INDEX IF NOT EXISTS idx_types_model     ON piece_types(model_id);
CREATE INDEX IF NOT EXISTS idx_placements_job  ON placements(job_id);
CREATE INDEX IF NOT EXISTS idx_placements_roll ON placements(roll_id);
CREATE INDEX IF NOT EXISTS idx_placements_model ON placements(model_id);
`);
}

// ---------- 旧库结构迁移 ----------

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

if (!hasColumn('defects', 'roll_id')) {
  db.exec('ALTER TABLE defects ADD COLUMN roll_id INTEGER');
}
if (!hasColumn('placements', 'roll_id')) {
  db.exec('ALTER TABLE placements ADD COLUMN roll_id INTEGER');
}
if (!hasColumn('placements', 'required_roll_id')) {
  db.exec('ALTER TABLE placements ADD COLUMN required_roll_id INTEGER');
}
if (!hasColumn('placements', 'unplaced_reason')) {
  db.exec('ALTER TABLE placements ADD COLUMN unplaced_reason TEXT');
}
if (!hasColumn('placements', 'cut')) {
  db.exec('ALTER TABLE placements ADD COLUMN cut INTEGER NOT NULL DEFAULT 0');
}
if (!hasColumn('rolls', 'cut_line')) {
  db.exec('ALTER TABLE rolls ADD COLUMN cut_line INTEGER NOT NULL DEFAULT 0');
}
if (!hasColumn('piece_types', 'model_id')) {
  db.exec('ALTER TABLE piece_types ADD COLUMN model_id INTEGER');
}
if (!hasColumn('piece_types', 'version')) {
  db.exec('ALTER TABLE piece_types ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
}
if (!hasColumn('piece_types', 'superseded_by')) {
  db.exec('ALTER TABLE piece_types ADD COLUMN superseded_by INTEGER');
}
if (!hasColumn('placements', 'model_id')) {
  db.exec('ALTER TABLE placements ADD COLUMN model_id INTEGER');
}

// 旧单卷方案：为每个无卷记录的方案补一卷「默认卷」，并把瑕疵与裁片挂到该卷
db.transaction(() => {
  const legacyJobs = db
    .prepare(
      `SELECT j.id, j.fabric_width, j.fabric_length FROM jobs j
       WHERE NOT EXISTS (SELECT 1 FROM rolls r WHERE r.job_id = j.id)`
    )
    .all();
  const insRoll = db.prepare(
    'INSERT INTO rolls (job_id, seq, label, width, length) VALUES (?, 1, ?, ?, ?)'
  );
  for (const j of legacyJobs) {
    const info = insRoll.run(j.id, '默认卷', j.fabric_width, j.fabric_length);
    db.prepare('UPDATE defects SET roll_id = ? WHERE job_id = ? AND roll_id IS NULL').run(
      info.lastInsertRowid,
      j.id
    );
    db.prepare('UPDATE placements SET roll_id = ? WHERE job_id = ? AND roll_id IS NULL').run(
      info.lastInsertRowid,
      j.id
    );
  }
})();

ensureIndices();

// 旧库纸样改版迁移：为每个尚无型号归属的纸样版本补一个 piece_models 行，并回填归属
db.transaction(() => {
  const insModel = db.prepare(
    'INSERT INTO piece_models (job_id, name, current_type_id) VALUES (?, ?, ?)'
  );
  const updType = db.prepare(
    'UPDATE piece_types SET model_id = ?, version = 1, superseded_by = NULL WHERE id = ?'
  );
  const updPlace = db.prepare('UPDATE placements SET model_id = ? WHERE piece_type_id = ? AND model_id IS NULL');
  const orphanTypes = db
    .prepare('SELECT id, job_id, name FROM piece_types WHERE model_id IS NULL ORDER BY id')
    .all();
  for (const t of orphanTypes) {
    const info = insModel.run(t.job_id, t.name, t.id);
    updType.run(info.lastInsertRowid, t.id);
    updPlace.run(info.lastInsertRowid, t.id);
  }
})();

module.exports = db;
