// 登入保护：在一段时间内失败太多次就锁住，挡住一直猜密码的人。
import type { Context } from 'hono';
import type { AppEnv, Env } from './env';
import { now } from './util';

const WINDOW = 15 * 60_000;

export interface Rule {
  max: number; // 时间窗内最多几次
  windowMs?: number;
  lockMs?: number; // 超过后锁多久
}

export const LOGIN_EMAIL: Rule = { max: 5, lockMs: 15 * 60_000 };
export const LOGIN_IP: Rule = { max: 20, lockMs: 30 * 60_000 };
export const DEMO_IP: Rule = { max: 20, windowMs: 60 * 60_000, lockMs: 60 * 60_000 };

export const clientIp = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'unknown';

/** 还锁着的话，回传剩几分钟；没锁回传 0 */
export async function lockedFor(env: Env, keys: string[]): Promise<number> {
  const t = now();
  const { results } = await env.DB.prepare('SELECT locked_until FROM login_attempts WHERE key IN (SELECT value FROM json_each(?)) AND locked_until > ?')
    .bind(JSON.stringify(keys), t)
    .all<{ locked_until: number }>();
  const until = Math.max(0, ...results.map((r) => r.locked_until));
  return until ? Math.ceil((until - t) / 60_000) : 0;
}

/** 记一次（失败或使用）。到上限就上锁。 */
export async function hit(env: Env, key: string, rule: Rule) {
  const t = now();
  const win = rule.windowMs ?? WINDOW;
  await env.DB.prepare(
    `INSERT INTO login_attempts (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start < ?2 - ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start < ?2 - ?3 THEN ?2 ELSE window_start END`,
  )
    .bind(key, t, win)
    .run();
  await env.DB.prepare('UPDATE login_attempts SET locked_until = ?, count = 0, window_start = ? WHERE key = ? AND count >= ?')
    .bind(t + (rule.lockMs ?? WINDOW), t, key, rule.max)
    .run();
}

export async function clear(env: Env, key: string) {
  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
}

export async function cleanupAttempts(env: Env) {
  const t = now();
  await env.DB.prepare('DELETE FROM login_attempts WHERE (locked_until IS NULL OR locked_until < ?) AND window_start < ?').bind(t, t - 2 * 60 * 60_000).run();
}
