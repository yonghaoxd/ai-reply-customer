// Email + 密码登入。session token 放在 HttpOnly cookie，数据库只存 token 的 sha-256。
import { Hono, type Context, type Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, SessionUser } from './env';
import { hashPassword, PASSWORD_ITERATIONS, randomToken, sha256Hex, timingSafeEqual, verifyPassword } from './crypto';
import { saveSettings } from './db';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { DAY, newId, now } from './util';
import { seedWorkspace } from './seed';
import { getTemplate } from '../shared/templates';
import { DEMO_USER, ensureDemo, isDemoSite } from './demo';
import { clear, clientIp, DEMO_IP, hit, lockedFor, LOGIN_EMAIL, LOGIN_IP } from './throttle';

const COOKIE = 'mcs_session';
const SESSION_TTL = 30 * DAY;

const isHttps = (c: Context<AppEnv>) => new URL(c.req.url).protocol === 'https:';
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function createSession(c: Context<AppEnv>, userId: string, ttl = SESSION_TTL) {
  const token = randomToken();
  const id = await sha256Hex(token);
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, userId, now() + ttl, now())
    .run();
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: ttl / 1000,
  });
}

export async function currentUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.workspace_id, u.email, u.name, u.role, s.expires_at, w.is_demo
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN workspaces w ON w.id = u.workspace_id WHERE s.id = ?`,
  )
    .bind(id)
    .first<{ id: string; workspace_id: string; email: string; name: string; role: 'owner' | 'agent'; expires_at: number; is_demo: number }>();
  if (!row || row.expires_at < now()) return null;
  // Demo 站只认 Demo 账号；你自己的站不认 Demo 账号
  if (!!row.is_demo !== isDemoSite(c.env)) return null;
  return { id: row.id, workspaceId: row.workspace_id, email: row.email, name: row.name, role: row.role, demo: !!row.is_demo };
}

/** Demo 账号可以用的「写」操作：开模拟顾客、用模拟顾客发信息、标已读、测试聊天、跑评测。其它一律只读。 */
const DEMO_WRITABLE = [
  /^\/api\/sim\/customers$/,
  /^\/api\/sim\/customers\/[^/]+\/messages$/,
  /^\/api\/sim\/customers\/[^/]+$/, // 删除自己开的模拟顾客（示范对话删不了）
  /^\/api\/conversations\/[^/]+\/read$/,
  /^\/api\/test-chat$/,
  /^\/api\/eval\/runs$/,
  /^\/api\/eval\/runs\/[^/]+\/cases\/[^/]+$/,
];

/** 所有 /api（登入相关除外）都要登入；改资料的请求要带 X-Requested-With，挡 CSRF。 */
export async function requireAuth(c: Context<AppEnv>, next: Next) {
  if (c.req.method !== 'GET' && c.req.header('x-requested-with') !== 'mcs') {
    return c.json({ error: 'bad_request' }, 400);
  }
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (user.demo && c.req.method !== 'GET' && !DEMO_WRITABLE.some((re) => re.test(new URL(c.req.url).pathname))) {
    return c.json({ error: 'demo_readonly', message: 'Demo 账号只能查看和用「模拟顾客」聊天，不能修改资料。(Demo is read-only.)' }, 403);
  }
  c.set('user', user);
  await next();
}

export async function requireOwner(c: Context<AppEnv>, next: Next) {
  if (c.get('user').role !== 'owner') return c.json({ error: 'forbidden', message: '只有老板账号可以做这个操作' }, 403);
  await next();
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.header('x-requested-with') !== 'mcs') return c.json({ error: 'bad_request' }, 400);
  await next();
});

authRoutes.get('/status', async (c) => {
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  const user = await currentUser(c);
  if (isDemoSite(c.env)) return c.json({ needsSetup: false, user, demoSite: true, repoUrl: c.env.REPO_URL || null });
  return c.json({ needsSetup: (n?.n ?? 0) === 0, user });
});

authRoutes.post('/setup', async (c) => {
  if (isDemoSite(c.env)) return c.json({ error: 'not_found' }, 404);
  const ipKey = 'ip:' + clientIp(c);
  const wait = await lockedFor(c.env, [ipKey]);
  if (wait) return c.json({ error: 'locked', message: `尝试太多次，请 ${wait} 分钟后再试` }, 429);
  const body = await c.req.json<{ setupKey?: string; workspaceName?: string; email?: string; name?: string; password?: string }>();
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  if ((n?.n ?? 0) > 0) return c.json({ error: 'already_setup', message: '系统已经初始化过了' }, 400);
  if (!c.env.SETUP_KEY || !body.setupKey || !timingSafeEqual(body.setupKey, c.env.SETUP_KEY)) {
    await hit(c.env, ipKey, LOGIN_IP);
    return c.json({ error: 'bad_setup_key', message: 'Setup key 不对' }, 403);
  }
  const email = (body.email || '').trim().toLowerCase();
  if (!validEmail(email)) return c.json({ error: 'bad_email', message: 'Email 格式不对' }, 400);
  if (!body.password || body.password.length < 8) return c.json({ error: 'weak_password', message: '密码至少 8 个字' }, 400);

  const wsId = newId('ws_');
  const userId = newId('u_');
  const pw = await hashPassword(body.password);
  const t = now();
  const wsName = (body.workspaceName || DEFAULT_SETTINGS.businessName).trim();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(wsId, wsName, t),
    c.env.DB.prepare(
      'INSERT INTO users (id, workspace_id, email, name, role, password_hash, password_salt, password_iter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(userId, wsId, email, (body.name || '老板').trim(), 'owner', pw.hash, pw.salt, pw.iterations, t),
  ]);
  const tpl = getTemplate('course')!.settings;
  const fill = (x: string) => x.replace(/\{business\}/g, wsName);
  await saveSettings(c.env, wsId, { ...DEFAULT_SETTINGS, businessName: wsName, botIdentity: fill(tpl.botIdentity), greeting: fill(tpl.greeting) });
  await seedWorkspace(c.env.DB, wsId);
  await createSession(c, userId);
  return c.json({ ok: true });
});

authRoutes.post('/login', async (c) => {
  if (isDemoSite(c.env)) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = (body.email || '').trim().toLowerCase().slice(0, 200);
  // 同一个 email 失败 5 次、或同一个 IP 失败 20 次，就锁一段时间
  const emailKey = 'email:' + email;
  const ipKey = 'ip:' + clientIp(c);
  const wait = await lockedFor(c.env, [emailKey, ipKey]);
  if (wait) return c.json({ error: 'locked', message: `登入失败太多次，请 ${wait} 分钟后再试` }, 429);
  const row = await c.env.DB.prepare('SELECT id, password_hash, password_salt, password_iter FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; password_hash: string; password_salt: string; password_iter: number }>();
  if (!row || !body.password || !(await verifyPassword(body.password, row.password_hash, row.password_salt, row.password_iter))) {
    await hit(c.env, emailKey, LOGIN_EMAIL);
    await hit(c.env, ipKey, LOGIN_IP);
    return c.json({ error: 'bad_login', message: 'Email 或密码不对' }, 401);
  }
  await clear(c.env, emailKey);
  // 迭代次数调高过 → 顺便升级
  if (row.password_iter < PASSWORD_ITERATIONS) {
    const pw = await hashPassword(body.password);
    await c.env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ?, password_iter = ? WHERE id = ?')
      .bind(pw.hash, pw.salt, pw.iterations, row.id)
      .run();
  }
  await createSession(c, row.id);
  return c.json({ ok: true });
});

/** 公开 Demo 站：不用密码，访客自动进示范账号（只读）。只在 Demo 站有效。 */
authRoutes.post('/demo', async (c) => {
  if (!isDemoSite(c.env)) return c.json({ error: 'not_found' }, 404);
  const ipKey = 'demo:' + clientIp(c);
  const wait = await lockedFor(c.env, [ipKey]);
  if (wait) return c.json({ error: 'locked', message: `请 ${wait} 分钟后再试 (Too many requests)` }, 429);
  await hit(c.env, ipKey, DEMO_IP);
  await ensureDemo(c.env);
  await createSession(c, DEMO_USER, DAY);
  return c.json({ ok: true });
});

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// ---------- 员工账号（需要登入）----------
export const userRoutes = new Hono<AppEnv>();

userRoutes.get('/', async (c) => {
  const u = c.get('user');
  const { results } = await c.env.DB.prepare('SELECT id, email, name, role, created_at FROM users WHERE workspace_id = ? ORDER BY created_at')
    .bind(u.workspaceId)
    .all();
  return c.json({ users: results });
});

userRoutes.post('/', requireOwner, async (c) => {
  const u = c.get('user');
  const body = await c.req.json<{ email?: string; name?: string; password?: string; role?: string }>();
  const email = (body.email || '').trim().toLowerCase();
  if (!validEmail(email)) return c.json({ error: 'bad_email', message: 'Email 格式不对' }, 400);
  if (!body.password || body.password.length < 8) return c.json({ error: 'weak_password', message: '密码至少 8 个字' }, 400);
  const exists = await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if (exists) return c.json({ error: 'email_taken', message: '这个 email 已经有账号' }, 400);
  const pw = await hashPassword(body.password);
  await c.env.DB.prepare(
    'INSERT INTO users (id, workspace_id, email, name, role, password_hash, password_salt, password_iter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(newId('u_'), u.workspaceId, email, (body.name || email).trim(), body.role === 'owner' ? 'owner' : 'agent', pw.hash, pw.salt, pw.iterations, now())
    .run();
  return c.json({ ok: true });
});

userRoutes.delete('/:id', requireOwner, async (c) => {
  const u = c.get('user');
  const id = c.req.param('id');
  if (id === u.id) return c.json({ error: 'self', message: '不能删除自己' }, 400);
  await c.env.DB.prepare('DELETE FROM users WHERE id = ? AND workspace_id = ?').bind(id, u.workspaceId).run();
  return c.json({ ok: true });
});

userRoutes.post('/me/password', async (c) => {
  const u = c.get('user');
  const body = await c.req.json<{ current?: string; next?: string }>();
  const row = await c.env.DB.prepare('SELECT password_hash, password_salt, password_iter FROM users WHERE id = ?')
    .bind(u.id)
    .first<{ password_hash: string; password_salt: string; password_iter: number }>();
  const key = 'email:' + u.email;
  const wait = await lockedFor(c.env, [key]);
  if (wait) return c.json({ error: 'locked', message: `失败太多次，请 ${wait} 分钟后再试` }, 429);
  if (!row || !body.current || !(await verifyPassword(body.current, row.password_hash, row.password_salt, row.password_iter))) {
    await hit(c.env, key, LOGIN_EMAIL);
    return c.json({ error: 'bad_password', message: '现在的密码不对' }, 400);
  }
  if (!body.next || body.next.length < 8) return c.json({ error: 'weak_password', message: '新密码至少 8 个字' }, 400);
  const pw = await hashPassword(body.next);
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ?, password_iter = ? WHERE id = ?')
    .bind(pw.hash, pw.salt, pw.iterations, u.id)
    .run();
  return c.json({ ok: true });
});
