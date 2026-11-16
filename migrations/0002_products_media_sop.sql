-- 产品资料库、产品图片/视频、销售 SOP

-- 「课程」升级成「产品」（课程也是一种产品）
CREATE TABLE products (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT '',
  price         TEXT,                               -- 文字，例如 "RM 299"；空 = bot 不报价
  audience      TEXT NOT NULL DEFAULT '',           -- 适合谁
  description   TEXT NOT NULL DEFAULT '',           -- 介绍
  selling_points TEXT NOT NULL DEFAULT '',          -- 卖点（每行一个）
  specs         TEXT NOT NULL DEFAULT '',           -- 规格 / 上课方式 / 内容
  faq           TEXT NOT NULL DEFAULT '',           -- 这个产品的常见问题
  link_url      TEXT NOT NULL DEFAULT '',           -- 购买 / 报名链接
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_products_ws ON products(workspace_id, sort_order);

INSERT INTO products (id, workspace_id, name, price, audience, description, link_url, enabled, sort_order, created_at, updated_at)
  SELECT id, workspace_id, name, price, audience, description, signup_url, enabled, sort_order, created_at, updated_at FROM courses;
DROP TABLE courses;

-- 图片 / 视频。档案本身存在 KV（key = kv_key），这里只存资料。
CREATE TABLE media (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  product_id    TEXT REFERENCES products(id) ON DELETE SET NULL, -- NULL = 通用（例如公司介绍）
  kind          TEXT NOT NULL,                      -- image | video
  title         TEXT NOT NULL DEFAULT '',           -- 说明，AI 靠这个判断什么时候发
  kv_key        TEXT NOT NULL UNIQUE,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  fb_attachment_id TEXT,                            -- Meta 的可重用附件 id（发过一次后缓存）
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_media_ws ON media(workspace_id, product_id, sort_order);

-- 销售 SOP 步骤
CREATE TABLE sop_stages (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  name          TEXT NOT NULL,
  goal          TEXT NOT NULL DEFAULT '',           -- 这一步要达成什么
  script        TEXT NOT NULL DEFAULT '',           -- 话术 / 做法
  exit_when     TEXT NOT NULL DEFAULT '',           -- 什么时候进入下一步
  media_ids     TEXT NOT NULL DEFAULT '[]',         -- 进入这一步时一定要发的图片/视频
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_sop_ws ON sop_stages(workspace_id, sort_order);

ALTER TABLE customers ADD COLUMN sop_stage_id TEXT;
ALTER TABLE customers ADD COLUMN sop_stage_at INTEGER;
ALTER TABLE customers ADD COLUMN sent_media TEXT NOT NULL DEFAULT '[]';  -- 已经发过的媒体 id

ALTER TABLE messages ADD COLUMN attachment TEXT;   -- JSON：{type, mediaId?, url?, title?}

-- 给现有 workspace 放一套默认 SOP（卖课程用，后台可以改）
INSERT INTO sop_stages (id, workspace_id, sort_order, name, goal, script, exit_when, created_at, updated_at)
SELECT 'sop1_' || id, id, 0, '了解需求',
  '弄清楚顾客做什么生意、现在遇到什么问题、想学什么。',
  '先回答顾客的问题，再自然地问一句他的情况，例如「你现在是做什么生意的？平时 FB 留言和私信多吗？」。一次只问一个问题。',
  '知道顾客的生意类型或想解决的问题。', strftime('%s','now') * 1000, strftime('%s','now') * 1000 FROM workspaces;
INSERT INTO sop_stages (id, workspace_id, sort_order, name, goal, script, exit_when, created_at, updated_at)
SELECT 'sop2_' || id, id, 1, '推荐产品',
  '根据顾客的情况推荐 1 个最合适的课程，说清楚它能帮他解决什么。',
  '用顾客自己说的问题来说明课程的好处，不要把所有课程都列出来。有介绍图片或视频的话可以发。',
  '顾客对推荐的课程有兴趣，或开始问细节。', strftime('%s','now') * 1000, strftime('%s','now') * 1000 FROM workspaces;
INSERT INTO sop_stages (id, workspace_id, sort_order, name, goal, script, exit_when, created_at, updated_at)
SELECT 'sop3_' || id, id, 2, '解答疑问',
  '回答价钱、上课方式、适不适合他等疑问，消除顾虑。',
  '只用产品资料和知识库回答。资料里没有的，说要请同事确认并转真人。',
  '顾客的疑问都回答了，或表示想报名。', strftime('%s','now') * 1000, strftime('%s','now') * 1000 FROM workspaces;
INSERT INTO sop_stages (id, workspace_id, sort_order, name, goal, script, exit_when, created_at, updated_at)
SELECT 'sop4_' || id, id, 3, '促成报名',
  '给报名链接，并收集名字、电话、email 方便同事跟进。',
  '给报名链接，简单说明报名步骤。问名字、电话和 email，不要一次逼太紧。',
  '顾客留了资料或说已经报名。', strftime('%s','now') * 1000, strftime('%s','now') * 1000 FROM workspaces;
INSERT INTO sop_stages (id, workspace_id, sort_order, name, goal, script, exit_when, created_at, updated_at)
SELECT 'sop5_' || id, id, 4, '已报名 / 跟进',
  '感谢顾客，告诉他接下来会怎样，并继续回答问题。',
  '感谢报名，说明同事会联系他确认。之后照常回答问题，不要再推销。',
  '', strftime('%s','now') * 1000, strftime('%s','now') * 1000 FROM workspaces;
