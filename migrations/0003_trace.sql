-- 每条 bot 回复的追踪记录（用了哪些资料、调用了什么工具、token、耗时）
ALTER TABLE messages ADD COLUMN trace TEXT;
