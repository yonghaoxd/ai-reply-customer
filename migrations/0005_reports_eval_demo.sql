-- 第三批：AI 评测、公开 Demo 账号

-- Demo workspace：一个独立的示范空间，只能看 + 用模拟顾客聊天
ALTER TABLE workspaces ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN demo_of TEXT;                           -- 是哪个 workspace 建的（借用它的 DeepSeek key）
ALTER TABLE workspaces ADD COLUMN demo_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workspaces ADD COLUMN demo_daily_cap INTEGER NOT NULL DEFAULT 100; -- 每天最多几次 AI 回复

-- Demo 每天用了几次 AI（day = 马来西亚时间的日期，例如 2026-11-16）
CREATE TABLE ai_usage (
  workspace_id  TEXT NOT NULL,
  day           TEXT NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);

-- AI 评测：固定的测试题 + 期望（checks 是 JSON，结构见 src/shared/evals.ts）
CREATE TABLE eval_cases (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  question      TEXT NOT NULL,
  checks        TEXT NOT NULL DEFAULT '{}',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_eval_cases_ws ON eval_cases(workspace_id, sort_order);

-- 每次跑评测的结果（results 是 JSON 数组，一题一项）
CREATE TABLE eval_runs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  model         TEXT NOT NULL DEFAULT '',
  total         INTEGER NOT NULL DEFAULT 0,
  passed        INTEGER NOT NULL DEFAULT 0,
  results       TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_eval_runs_ws ON eval_runs(workspace_id, created_at DESC);
