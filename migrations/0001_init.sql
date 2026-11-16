-- Messenger AI 客服系统 — 初始数据库
-- 所有时间都是 Unix 毫秒（INTEGER）。每张业务表都带 workspace_id，方便以后多用户。

CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'agent',      -- owner | agent
  password_hash TEXT NOT NULL,                      -- base64
  password_salt TEXT NOT NULL,                      -- base64
  password_iter INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,                   -- sha-256 of the cookie token
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- 连接的 FB Page。page_token 用 ENCRYPTION_KEY 加密后存。
CREATE TABLE fb_pages (
  page_id       TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL DEFAULT '',
  page_token_enc TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- 每个 workspace 一行，所有可调设定放在 JSON 里（结构见 src/shared/settings.ts）
CREATE TABLE bot_settings (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id),
  settings_json TEXT NOT NULL,
  deepseek_key_enc TEXT,
  telegram_token_enc TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE customers (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  page_id       TEXT NOT NULL,
  psid          TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  profile_pic   TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',         -- JSON array
  notes         TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',           -- AI 写的长期记忆
  summary_msg_count INTEGER NOT NULL DEFAULT 0,     -- 上次写摘要时的信息数
  bot_paused    INTEGER NOT NULL DEFAULT 0,         -- 1 = 真人接管中
  paused_until  INTEGER,                            -- 自动交还 bot 的时间；NULL = 不自动交还
  needs_human   INTEGER NOT NULL DEFAULT 0,         -- 1 = 等真人处理
  unread        INTEGER NOT NULL DEFAULT 0,
  greeted       INTEGER NOT NULL DEFAULT 0,         -- 是否已发开场白
  last_inbound_at  INTEGER,                         -- 顾客最后一次发信息（24 小时窗口）
  last_message_at  INTEGER,
  last_message_preview TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  UNIQUE (page_id, psid)
);
CREATE INDEX idx_customers_ws_last ON customers(workspace_id, last_message_at DESC);

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,                      -- customer | bot | human | system
  text          TEXT NOT NULL,
  meta_mid      TEXT UNIQUE,                        -- Meta 的 message id（去重用）
  sender_user_id TEXT,                              -- 后台回复时是哪个员工
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_messages_customer ON messages(customer_id, created_at);

-- 去重：Meta 可能重发同一个 webhook
CREATE TABLE processed_events (
  mid           TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL
);

CREATE TABLE kb_documents (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  title         TEXT NOT NULL,
  source_type   TEXT NOT NULL,                      -- text | pdf | docx
  content       TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'ready',      -- ready | error
  error         TEXT,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE kb_chunks (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  document_id   TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,
  text          TEXT NOT NULL,
  embedding     BLOB                                -- Float32Array；NULL = 向量还没生成，用关键词检索
);
CREATE INDEX idx_kb_chunks_ws ON kb_chunks(workspace_id);
CREATE INDEX idx_kb_chunks_doc ON kb_chunks(document_id);

CREATE TABLE courses (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  price         TEXT,                               -- 文字，例如 "RM 299"；空 = bot 不报价
  audience      TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  signup_url    TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE leads (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  customer_id   TEXT REFERENCES customers(id) ON DELETE SET NULL,
  name          TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  interest      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'new',        -- new | contacted | enrolled | lost
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_leads_ws ON leads(workspace_id, created_at DESC);
CREATE UNIQUE INDEX idx_leads_customer ON leads(customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE handoffs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  source        TEXT NOT NULL,                      -- keyword | ai | echo | manual
  resolved_by   TEXT,
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);
CREATE INDEX idx_handoffs_customer ON handoffs(customer_id);

-- 预留给以后的预约功能（v1 不使用）
CREATE TABLE bookings (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  customer_id   TEXT REFERENCES customers(id) ON DELETE SET NULL,
  service       TEXT NOT NULL,
  starts_at     INTEGER NOT NULL,
  ends_at       INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'booked',
  notes         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
