import type { Env } from './env';
import { mergeSettings, type BotSettings } from '../shared/settings';
import { decryptSecret } from './crypto';
import { newId, now, truncate } from './util';
import { SIM_TOKEN } from './meta';

export interface CustomerRow {
  id: string;
  workspace_id: string;
  page_id: string;
  psid: string;
  name: string;
  profile_pic: string | null;
  tags: string;
  notes: string;
  summary: string;
  summary_msg_count: number;
  bot_paused: number;
  paused_until: number | null;
  needs_human: number;
  unread: number;
  greeted: number;
  last_inbound_at: number | null;
  last_message_at: number | null;
  last_message_preview: string;
  sop_stage_id: string | null;
  sop_stage_at: number | null;
  sent_media: string;
  follow_up_count: number;
  created_at: number;
}

export interface MessageRow {
  id: string;
  workspace_id: string;
  customer_id: string;
  role: 'customer' | 'bot' | 'human' | 'system';
  text: string;
  meta_mid: string | null;
  sender_user_id: string | null;
  attachment: string | null;
  trace: string | null;
  created_at: number;
}

export interface ProductRow {
  id: string;
  workspace_id: string;
  name: string;
  category: string;
  price: string | null;
  audience: string;
  description: string;
  selling_points: string;
  specs: string;
  faq: string;
  link_url: string;
  enabled: number;
  sort_order: number;
}

export interface MediaRow {
  id: string;
  workspace_id: string;
  product_id: string | null;
  kind: 'image' | 'video';
  title: string;
  kv_key: string;
  mime: string;
  size: number;
  fb_attachment_id: string | null;
  sort_order: number;
  created_at: number;
}

export interface SopStageRow {
  id: string;
  workspace_id: string;
  sort_order: number;
  name: string;
  goal: string;
  script: string;
  exit_when: string;
  media_ids: string;
  follow_up: string;
}

// ---------- 设定 ----------
export async function loadSettings(env: Env, workspaceId: string): Promise<BotSettings> {
  const row = await env.DB.prepare('SELECT settings_json FROM bot_settings WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ settings_json: string }>();
  let raw: unknown = {};
  try {
    raw = row ? JSON.parse(row.settings_json) : {};
  } catch {
    raw = {};
  }
  return mergeSettings(raw);
}

export async function saveSettings(env: Env, workspaceId: string, s: BotSettings) {
  await env.DB.prepare(
    `INSERT INTO bot_settings (workspace_id, settings_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
  )
    .bind(workspaceId, JSON.stringify(s), now())
    .run();
}

export async function loadSecrets(env: Env, workspaceId: string) {
  const row = await env.DB.prepare('SELECT deepseek_key_enc, telegram_token_enc FROM bot_settings WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ deepseek_key_enc: string | null; telegram_token_enc: string | null }>();
  // 公开 Demo 站：用 Demo 专用的 key（跟你自己的站完全分开）
  if (env.DEMO_SITE) return { deepseekKey: env.DEMO_DEEPSEEK_KEY || null, telegramToken: null };
  return {
    deepseekKey: await decryptSecret(row?.deepseek_key_enc, env.ENCRYPTION_KEY),
    telegramToken: await decryptSecret(row?.telegram_token_enc, env.ENCRYPTION_KEY),
  };
}

export const simPageId = (workspaceId: string) => `sim:${workspaceId}`;
export const isSimPage = (pageId: string) => pageId.startsWith('sim:');

export async function getPage(env: Env, pageId: string) {
  // 模拟顾客：不需要真的 FB Page
  if (isSimPage(pageId)) return { page_id: pageId, workspace_id: pageId.slice(4), name: '模拟', page_token_enc: '', token: SIM_TOKEN as string | null };
  const row = await env.DB.prepare('SELECT page_id, workspace_id, name, page_token_enc FROM fb_pages WHERE page_id = ?')
    .bind(pageId)
    .first<{ page_id: string; workspace_id: string; name: string; page_token_enc: string }>();
  if (!row) return null;
  return { ...row, token: await decryptSecret(row.page_token_enc, env.ENCRYPTION_KEY) };
}

export async function getWorkspacePage(env: Env, workspaceId: string) {
  const row = await env.DB.prepare('SELECT page_id FROM fb_pages WHERE workspace_id = ? LIMIT 1')
    .bind(workspaceId)
    .first<{ page_id: string }>();
  return row ? getPage(env, row.page_id) : null;
}

// ---------- 顾客 ----------
export async function getOrCreateCustomer(env: Env, workspaceId: string, pageId: string, psid: string) {
  const existing = await env.DB.prepare('SELECT * FROM customers WHERE page_id = ? AND psid = ?')
    .bind(pageId, psid)
    .first<CustomerRow>();
  if (existing) return { customer: existing, created: false };
  const id = newId('c_');
  const t = now();
  await env.DB.prepare(
    `INSERT INTO customers (id, workspace_id, page_id, psid, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(page_id, psid) DO NOTHING`,
  )
    .bind(id, workspaceId, pageId, psid, t)
    .run();
  const row = await env.DB.prepare('SELECT * FROM customers WHERE page_id = ? AND psid = ?')
    .bind(pageId, psid)
    .first<CustomerRow>();
  return { customer: row!, created: row!.id === id };
}

export async function getCustomer(env: Env, workspaceId: string, id: string) {
  return env.DB.prepare('SELECT * FROM customers WHERE id = ? AND workspace_id = ?').bind(id, workspaceId).first<CustomerRow>();
}

// ---------- 信息 ----------
export async function addMessage(
  env: Env,
  c: CustomerRow,
  role: MessageRow['role'],
  text: string,
  opts: { mid?: string | null; userId?: string | null; at?: number; attachment?: Record<string, unknown> | null; trace?: Record<string, unknown> | null } = {},
): Promise<boolean> {
  const t = opts.at ?? now();
  const res = await env.DB.prepare(
    `INSERT INTO messages (id, workspace_id, customer_id, role, text, meta_mid, sender_user_id, attachment, trace, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(meta_mid) DO NOTHING`,
  )
    .bind(newId('m_'), c.workspace_id, c.id, role, text, opts.mid ?? null, opts.userId ?? null, opts.attachment ? JSON.stringify(opts.attachment) : null, opts.trace ? JSON.stringify(opts.trace) : null, t)
    .run();
  if (!res.meta.changes) return false;

  const preview = truncate(text.replace(/\s+/g, ' '), 80);
  if (role === 'customer') {
    await env.DB.prepare(
      `UPDATE customers SET last_message_at = ?, last_message_preview = ?, last_inbound_at = ?, unread = unread + 1, follow_up_count = 0 WHERE id = ?`,
    )
      .bind(t, preview, t, c.id)
      .run();
  } else {
    await env.DB.prepare(`UPDATE customers SET last_message_at = ?, last_message_preview = ? WHERE id = ?`)
      .bind(t, preview, c.id)
      .run();
  }
  return true;
}

export async function recentMessages(env: Env, customerId: string, limit: number) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM (SELECT * FROM messages WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC`,
  )
    .bind(customerId, limit)
    .all<MessageRow>();
  return results;
}

export async function countMessages(env: Env, customerId: string) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE customer_id = ?').bind(customerId).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function listProducts(env: Env, workspaceId: string, onlyEnabled = true) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM products WHERE workspace_id = ? ${onlyEnabled ? 'AND enabled = 1' : ''} ORDER BY sort_order, created_at`,
  )
    .bind(workspaceId)
    .all<ProductRow>();
  return results;
}

export async function listMedia(env: Env, workspaceId: string) {
  const { results } = await env.DB.prepare('SELECT * FROM media WHERE workspace_id = ? ORDER BY product_id, sort_order, created_at')
    .bind(workspaceId)
    .all<MediaRow>();
  return results;
}

export async function listStages(env: Env, workspaceId: string) {
  const { results } = await env.DB.prepare('SELECT * FROM sop_stages WHERE workspace_id = ? ORDER BY sort_order, created_at')
    .bind(workspaceId)
    .all<SopStageRow>();
  return results;
}

export async function setCustomerStage(env: Env, customerId: string, stageId: string | null) {
  await env.DB.prepare('UPDATE customers SET sop_stage_id = ?, sop_stage_at = ? WHERE id = ?').bind(stageId, stageId ? now() : null, customerId).run();
}

/** 把顾客设为真人接管。 */
export async function pauseBot(env: Env, c: CustomerRow, settings: BotSettings, needsHuman: boolean) {
  const until = settings.autoResumeEnabled ? now() + settings.autoResumeHours * 3600_000 : null;
  await env.DB.prepare('UPDATE customers SET bot_paused = 1, paused_until = ?, needs_human = ? WHERE id = ?')
    .bind(until, needsHuman ? 1 : 0, c.id)
    .run();
  c.bot_paused = 1;
  c.paused_until = until;
  c.needs_human = needsHuman ? 1 : 0;
}

export async function resumeBot(env: Env, customerId: string) {
  await env.DB.prepare('UPDATE customers SET bot_paused = 0, paused_until = NULL, needs_human = 0 WHERE id = ?').bind(customerId).run();
  await env.DB.prepare('UPDATE handoffs SET resolved_at = ? WHERE customer_id = ? AND resolved_at IS NULL').bind(now(), customerId).run();
}

export async function recordHandoff(env: Env, c: CustomerRow, reason: string, source: string) {
  await env.DB.prepare(
    'INSERT INTO handoffs (id, workspace_id, customer_id, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(newId('h_'), c.workspace_id, c.id, reason, source, now())
    .run();
}
