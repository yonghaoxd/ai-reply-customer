-- 登入保护：同一个 email 或同一个 IP 失败太多次就暂时锁住
CREATE TABLE login_attempts (
  key           TEXT PRIMARY KEY,                   -- email:xxx 或 ip:xxx 或 demo:ip
  count         INTEGER NOT NULL DEFAULT 0,
  window_start  INTEGER NOT NULL,
  locked_until  INTEGER
);
