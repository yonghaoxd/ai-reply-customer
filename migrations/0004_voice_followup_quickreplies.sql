-- 自动跟进 + 快捷回复

-- 每个 SOP 步骤可以写自己的跟进话术（空 = 用 Bot 设定里的默认跟进话术）
ALTER TABLE sop_stages ADD COLUMN follow_up TEXT NOT NULL DEFAULT '';

-- 这个顾客在最后一次发信息之后，bot 已经跟进了几次（顾客一回复就归零）
ALTER TABLE customers ADD COLUMN follow_up_count INTEGER NOT NULL DEFAULT 0;

-- Inbox 快捷回复
CREATE TABLE quick_replies (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  title         TEXT NOT NULL,
  text          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_quick_replies_ws ON quick_replies(workspace_id, sort_order);
