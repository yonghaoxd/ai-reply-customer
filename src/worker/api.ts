// 后台 API（都已经过 requireAuth）。
import { Hono } from 'hono';
import type { AppEnv } from './env';
import {
  addMessage,
  getCustomer,
  getWorkspacePage,
  getPage,
  getOrCreateCustomer,
  isSimPage,
  simPageId,
  loadSecrets,
  loadSettings,
  pauseBot,
  resumeBot,
  saveSettings,
  listMedia,
  listStages,
  setCustomerStage,
  type CustomerRow,
  type MediaRow,
  type SopStageRow,
} from './db';
import { deleteMedia, mediaUrl, sendMediaToCustomer, uploadMedia } from './media';
import { mergeSettings } from '../shared/settings';
import { encryptSecret } from './crypto';
import { connectPage, MetaError, sendText } from './meta';
import { sendTelegram } from './telegram';
import { indexDocument, MAX_DOC_CHARS } from './kb';
import { historyToChat, matchesAny, processJob, runAgent, stageMediaFor, voiceHint } from './bot';
import { getTemplate, TEMPLATES } from '../shared/templates';
import { MAX_AUDIO_BYTES, transcribeBytes } from './voice';
import { runFollowUps } from './followup';
import { DAY, HOUR, newId, now, parseJson } from './util';
import { requireOwner } from './auth';
import { insights } from './insights';
import { bumpUsage, demoQuota, trimDemoSims, DEMO_LIMIT_REPLY, SEED_PSID_PREFIX } from './demo';

export const api = new Hono<AppEnv>();
api.route('/', insights);

const ws = (c: { get: (k: 'user') => { workspaceId: string } }) => c.get('user').workspaceId;

function customerOut(c: CustomerRow) {
  const t = now();
  return {
    id: c.id,
    psid: c.psid,
    name: c.name,
    profilePic: c.profile_pic,
    tags: parseJson<string[]>(c.tags, []),
    notes: c.notes,
    summary: c.summary,
    botPaused: !!c.bot_paused,
    pausedUntil: c.paused_until,
    needsHuman: !!c.needs_human,
    unread: c.unread,
    lastInboundAt: c.last_inbound_at,
    lastMessageAt: c.last_message_at,
    lastMessagePreview: c.last_message_preview,
    windowOpen: !!c.last_inbound_at && t - c.last_inbound_at < DAY,
    windowEndsAt: c.last_inbound_at ? c.last_inbound_at + DAY : null,
    stageId: c.sop_stage_id,
    sentMedia: parseJson<string[]>(c.sent_media, []),
    isSim: isSimPage(c.page_id),
    createdAt: c.created_at,
  };
}

// ======================= Inbox =======================
api.get('/conversations', async (c) => {
  const filter = c.req.query('filter') || 'all';
  const q = (c.req.query('q') || '').trim();
  let where = 'workspace_id = ? AND last_message_at IS NOT NULL';
  const args: unknown[] = [ws(c)];
  if (filter === 'unread') where += ' AND unread > 0';
  if (filter === 'human') where += ' AND (needs_human = 1 OR bot_paused = 1)';
  if (q) {
    where += ' AND (name LIKE ? OR last_message_preview LIKE ? OR tags LIKE ? OR notes LIKE ?)';
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  const { results } = await c.env.DB.prepare(`SELECT * FROM customers WHERE ${where} ORDER BY last_message_at DESC LIMIT 200`)
    .bind(...args)
    .all<CustomerRow>();
  const counts = await c.env.DB.prepare(
    `SELECT SUM(CASE WHEN unread > 0 THEN 1 ELSE 0 END) AS unread, SUM(CASE WHEN needs_human = 1 OR bot_paused = 1 THEN 1 ELSE 0 END) AS human
     FROM customers WHERE workspace_id = ?`,
  )
    .bind(ws(c))
    .first<{ unread: number | null; human: number | null }>();
  return c.json({ conversations: results.map(customerOut), counts: { unread: counts?.unread ?? 0, human: counts?.human ?? 0 } });
});

api.get('/conversations/:id', async (c) => {
  const cust = await getCustomer(c.env, ws(c), c.req.param('id'));
  if (!cust) return c.json({ error: 'not_found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.role, m.text, m.attachment, m.trace, m.created_at AS createdAt, u.name AS senderName FROM
       (SELECT * FROM messages WHERE customer_id = ? ORDER BY created_at DESC LIMIT 300) m
     LEFT JOIN users u ON u.id = m.sender_user_id ORDER BY m.created_at ASC`,
  )
    .bind(cust.id)
    .all();
  const lead = await c.env.DB.prepare('SELECT * FROM leads WHERE customer_id = ?').bind(cust.id).first();
  const handoff = await c.env.DB.prepare('SELECT reason, created_at AS createdAt FROM handoffs WHERE customer_id = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .bind(cust.id)
    .first();
  const messages = (results as Record<string, unknown>[]).map((m) => ({ ...m, attachment: parseJson(m.attachment as string | null, null), trace: parseJson(m.trace as string | null, null) }));
  return c.json({ customer: customerOut(cust), messages, lead, handoff });
});

api.post('/conversations/:id/read', async (c) => {
  await c.env.DB.prepare('UPDATE customers SET unread = 0 WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), ws(c)).run();
  return c.json({ ok: true });
});

api.post('/conversations/:id/messages', async (c) => {
  const user = c.get('user');
  const cust = await getCustomer(c.env, ws(c), c.req.param('id'));
  if (!cust) return c.json({ error: 'not_found' }, 404);
  const { text, humanAgent } = await c.req.json<{ text?: string; humanAgent?: boolean }>();
  const body = (text || '').trim();
  if (!body) return c.json({ error: 'empty', message: '不能发空白信息' }, 400);

  const age = cust.last_inbound_at ? now() - cust.last_inbound_at : Infinity;
  const useTag = age >= DAY;
  if (useTag && (!humanAgent || age >= 7 * DAY)) {
    return c.json({ error: 'window_closed', message: '顾客最后一条信息已超过 24 小时，Meta 不允许再发信息（除非已获批 Human Agent 权限，且在 7 天内）。' }, 400);
  }
  const page = await getPage(c.env, cust.page_id);
  if (!page?.token) return c.json({ error: 'no_page', message: '还没有连接 FB Page' }, 400);
  try {
    const ids = await sendText(c.env, page.token, cust.psid, body, useTag);
    await addMessage(c.env, cust, 'human', body, { mid: ids[0] ?? null, userId: user.id });
  } catch (e) {
    const msg = e instanceof MetaError ? e.message : (e as Error).message;
    return c.json({ error: 'send_failed', message: `发送失败：${msg}` }, 502);
  }
  // 后台亲自回复 = 接管
  const settings = await loadSettings(c.env, ws(c));
  await pauseBot(c.env, cust, settings, false);
  await c.env.DB.prepare('UPDATE customers SET unread = 0 WHERE id = ?').bind(cust.id).run();
  await c.env.DB.prepare('UPDATE handoffs SET resolved_at = ?, resolved_by = ? WHERE customer_id = ? AND resolved_at IS NULL')
    .bind(now(), user.id, cust.id)
    .run();
  return c.json({ ok: true });
});

api.post('/conversations/:id/stage', async (c) => {
  const cust = await getCustomer(c.env, ws(c), c.req.param('id'));
  if (!cust) return c.json({ error: 'not_found' }, 404);
  const { stageId } = await c.req.json<{ stageId: string | null }>();
  if (stageId) {
    const ok = await c.env.DB.prepare('SELECT 1 FROM sop_stages WHERE id = ? AND workspace_id = ?').bind(stageId, ws(c)).first();
    if (!ok) return c.json({ error: 'bad_stage' }, 400);
  }
  await setCustomerStage(c.env, cust.id, stageId || null);
  return c.json({ ok: true });
});

/** 后台员工从媒体库发图片/视频给顾客 */
api.post('/conversations/:id/media', async (c) => {
  const user = c.get('user');
  const cust = await getCustomer(c.env, ws(c), c.req.param('id'));
  if (!cust) return c.json({ error: 'not_found' }, 404);
  const { mediaId, humanAgent } = await c.req.json<{ mediaId?: string; humanAgent?: boolean }>();
  const m = await c.env.DB.prepare('SELECT * FROM media WHERE id = ? AND workspace_id = ?').bind(mediaId || '', ws(c)).first<MediaRow>();
  if (!m) return c.json({ error: 'not_found', message: '找不到这个档案' }, 404);
  const age = cust.last_inbound_at ? now() - cust.last_inbound_at : Infinity;
  const useTag = age >= DAY;
  if (useTag && (!humanAgent || age >= 7 * DAY)) {
    return c.json({ error: 'window_closed', message: '顾客最后一条信息已超过 24 小时，Meta 不允许再发信息。' }, 400);
  }
  const page = await getPage(c.env, cust.page_id);
  if (!page?.token) return c.json({ error: 'no_page', message: '还没有连接 FB Page' }, 400);
  try {
    await sendMediaToCustomer(c.env, page.token, cust, m, 'human', { userId: user.id, humanAgent: useTag });
  } catch (e) {
    return c.json({ error: 'send_failed', message: `发送失败：${(e as Error).message}` }, 502);
  }
  const settings = await loadSettings(c.env, ws(c));
  await pauseBot(c.env, cust, settings, false);
  return c.json({ ok: true });
});

api.post('/conversations/:id/pause', async (c) => {
  const cust = await getCustomer(c.env, ws(c), c.req.param('id'));
  if (!cust) return c.json({ error: 'not_found' }, 404);
  const { paused } = await c.req.json<{ paused: boolean }>();
  if (paused) {
    const settings = await loadSettings(c.env, ws(c));
    await pauseBot(c.env, cust, settings, false);
  } else {
    await resumeBot(c.env, cust.id);
  }
  return c.json({ ok: true });
});

// ======================= 顾客 =======================
api.get('/customers', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const tag = (c.req.query('tag') || '').trim();
  let where = 'workspace_id = ?';
  const args: unknown[] = [ws(c)];
  if (q) {
    where += ' AND (name LIKE ? OR notes LIKE ? OR summary LIKE ?)';
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (tag) {
    where += ' AND tags LIKE ?';
    args.push(`%${JSON.stringify(tag).slice(1, -1)}%`);
  }
  const { results } = await c.env.DB.prepare(`SELECT * FROM customers WHERE ${where} ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 500`)
    .bind(...args)
    .all<CustomerRow>();
  return c.json({ customers: results.map(customerOut) });
});

api.patch('/customers/:id', async (c) => {
  const cust = await getCustomer(c.env, ws(c), c.req.param('id'));
  if (!cust) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json<{ name?: string; tags?: string[]; notes?: string; summary?: string }>();
  const tags = Array.isArray(b.tags) ? [...new Set(b.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20) : parseJson<string[]>(cust.tags, []);
  await c.env.DB.prepare('UPDATE customers SET name = ?, tags = ?, notes = ?, summary = ? WHERE id = ?')
    .bind(
      b.name !== undefined ? String(b.name).slice(0, 100) : cust.name,
      JSON.stringify(tags),
      b.notes !== undefined ? String(b.notes).slice(0, 5000) : cust.notes,
      b.summary !== undefined ? String(b.summary).slice(0, 2000) : cust.summary,
      cust.id,
    )
    .run();
  return c.json({ ok: true });
});

api.get('/tags', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT tags FROM customers WHERE workspace_id = ? AND tags != '[]'`).bind(ws(c)).all<{ tags: string }>();
  const set = new Set<string>();
  for (const r of results) for (const t of parseJson<string[]>(r.tags, [])) set.add(t);
  return c.json({ tags: [...set].sort() });
});

// ======================= Leads =======================
const LEAD_STATUS = ['new', 'contacted', 'enrolled', 'lost'];

api.get('/leads', async (c) => {
  const status = c.req.query('status');
  const args: unknown[] = [ws(c)];
  let where = 'l.workspace_id = ?';
  if (status && LEAD_STATUS.includes(status)) {
    where += ' AND l.status = ?';
    args.push(status);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT l.*, c.name AS customer_name FROM leads l LEFT JOIN customers c ON c.id = l.customer_id WHERE ${where} ORDER BY l.created_at DESC LIMIT 1000`,
  )
    .bind(...args)
    .all();
  return c.json({ leads: results });
});

api.post('/leads', async (c) => {
  const b = await c.req.json<Record<string, string>>();
  const t = now();
  await c.env.DB.prepare(
    'INSERT INTO leads (id, workspace_id, name, phone, email, interest, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(newId('l_'), ws(c), b.name || '', b.phone || '', b.email || '', b.interest || '', LEAD_STATUS.includes(b.status) ? b.status : 'new', t, t)
    .run();
  return c.json({ ok: true });
});

api.patch('/leads/:id', async (c) => {
  const b = await c.req.json<Record<string, string>>();
  const row = await c.env.DB.prepare('SELECT * FROM leads WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), ws(c)).first<Record<string, string>>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const pick = (k: string) => (b[k] !== undefined ? String(b[k]).slice(0, 300) : row[k]);
  await c.env.DB.prepare('UPDATE leads SET name = ?, phone = ?, email = ?, interest = ?, status = ?, updated_at = ? WHERE id = ?')
    .bind(pick('name'), pick('phone'), pick('email'), pick('interest'), LEAD_STATUS.includes(b.status) ? b.status : row.status, now(), row.id)
    .run();
  return c.json({ ok: true });
});

api.delete('/leads/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM leads WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), ws(c)).run();
  return c.json({ ok: true });
});

api.get('/leads.csv', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT name, phone, email, interest, status, created_at FROM leads WHERE workspace_id = ? ORDER BY created_at DESC')
    .bind(ws(c))
    .all<Record<string, string | number>>();
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['name', 'phone', 'email', 'interest', 'status', 'created_at'].join(',')];
  for (const r of results) {
    lines.push([r.name, r.phone, r.email, r.interest, r.status, new Date(Number(r.created_at)).toISOString()].map(esc).join(','));
  }
  return new Response('﻿' + lines.join('\n'), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads.csv"' },
  });
});

// ======================= 产品 =======================
api.get('/products', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM products WHERE workspace_id = ? ORDER BY sort_order, created_at').bind(ws(c)).all();
  return c.json({ products: results });
});

function productFields(b: Record<string, unknown>) {
  const s = (k: string, n = 4000) => (b[k] === undefined || b[k] === null ? null : String(b[k]).slice(0, n));
  return {
    name: s('name', 200),
    category: s('category', 100),
    price: s('price', 100),
    audience: s('audience', 500),
    description: s('description'),
    selling_points: s('sellingPoints'),
    specs: s('specs'),
    faq: s('faq', 8000),
    link_url: s('linkUrl', 500),
    enabled: b.enabled === undefined ? null : b.enabled ? 1 : 0,
    sort_order: b.sortOrder === undefined ? null : Number(b.sortOrder) || 0,
  };
}

api.post('/products', async (c) => {
  const f = productFields(await c.req.json());
  if (!f.name?.trim()) return c.json({ error: 'name_required', message: '要填产品名称' }, 400);
  const t = now();
  const max = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM products WHERE workspace_id = ?').bind(ws(c)).first<{ m: number }>();
  const id = newId('p_');
  await c.env.DB.prepare(
    `INSERT INTO products (id, workspace_id, name, category, price, audience, description, selling_points, specs, faq, link_url, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, ws(c), f.name, f.category ?? '', f.price?.trim() || null, f.audience ?? '', f.description ?? '', f.selling_points ?? '',
      f.specs ?? '', f.faq ?? '', f.link_url ?? '', f.enabled ?? 1, f.sort_order ?? (max?.m ?? -1) + 1, t, t,
    )
    .run();
  return c.json({ ok: true, id });
});

api.patch('/products/:id', async (c) => {
  const f = productFields(await c.req.json());
  await c.env.DB.prepare(
    `UPDATE products SET name = COALESCE(?, name), category = COALESCE(?, category),
     price = CASE WHEN ? IS NULL THEN price ELSE NULLIF(TRIM(?), '') END,
     audience = COALESCE(?, audience), description = COALESCE(?, description), selling_points = COALESCE(?, selling_points),
     specs = COALESCE(?, specs), faq = COALESCE(?, faq), link_url = COALESCE(?, link_url),
     enabled = COALESCE(?, enabled), sort_order = COALESCE(?, sort_order), updated_at = ? WHERE id = ? AND workspace_id = ?`,
  )
    .bind(
      f.name, f.category, f.price, f.price, f.audience, f.description, f.selling_points, f.specs, f.faq, f.link_url,
      f.enabled, f.sort_order, now(), c.req.param('id'), ws(c),
    )
    .run();
  return c.json({ ok: true });
});

api.delete('/products/:id', async (c) => {
  const id = c.req.param('id');
  // 这个产品的图片/视频一起删
  const { results } = await c.env.DB.prepare('SELECT id FROM media WHERE product_id = ? AND workspace_id = ?').bind(id, ws(c)).all<{ id: string }>();
  for (const m of results) await deleteMedia(c.env, ws(c), m.id);
  await c.env.DB.prepare('DELETE FROM products WHERE id = ? AND workspace_id = ?').bind(id, ws(c)).run();
  return c.json({ ok: true });
});

// ======================= 图片 / 视频 =======================
function mediaOut(env: AppEnv['Bindings'], m: MediaRow) {
  return { id: m.id, productId: m.product_id, kind: m.kind, title: m.title, mime: m.mime, size: m.size, sortOrder: m.sort_order, url: mediaUrl(env, m.kv_key), createdAt: m.created_at };
}

api.get('/media', async (c) => {
  const rows = await listMedia(c.env, ws(c));
  return c.json({ media: rows.map((m) => mediaOut(c.env, m)) });
});

api.put('/media', uploadMedia);

api.patch('/media/:id', async (c) => {
  const b = await c.req.json<{ title?: string; productId?: string | null; sortOrder?: number }>();
  const row = await c.env.DB.prepare('SELECT * FROM media WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), ws(c)).first<MediaRow>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  await c.env.DB.prepare('UPDATE media SET title = ?, product_id = ?, sort_order = ? WHERE id = ?')
    .bind(
      b.title !== undefined ? String(b.title).slice(0, 200) : row.title,
      b.productId !== undefined ? b.productId || null : row.product_id,
      b.sortOrder !== undefined ? Number(b.sortOrder) || 0 : row.sort_order,
      row.id,
    )
    .run();
  return c.json({ ok: true });
});

api.delete('/media/:id', async (c) => {
  const ok = await deleteMedia(c.env, ws(c), c.req.param('id'));
  return ok ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
});

// ======================= 销售 SOP =======================
function stageOut(st: SopStageRow) {
  return { id: st.id, sortOrder: st.sort_order, name: st.name, goal: st.goal, script: st.script, exitWhen: st.exit_when, followUp: st.follow_up, mediaIds: parseJson<string[]>(st.media_ids, []) };
}

api.get('/sop', async (c) => {
  const stages = await listStages(c.env, ws(c));
  const counts = await c.env.DB.prepare('SELECT sop_stage_id AS id, COUNT(*) AS n FROM customers WHERE workspace_id = ? GROUP BY sop_stage_id')
    .bind(ws(c))
    .all<{ id: string | null; n: number }>();
  return c.json({ stages: stages.map(stageOut), counts: Object.fromEntries(counts.results.map((r) => [r.id ?? 'none', r.n])) });
});

/** 整套 SOP 一次保存（新增、修改、删除、排序）。 */
api.put('/sop', requireOwner, async (c) => {
  const body = await c.req.json<{ stages?: { id?: string; name?: string; goal?: string; script?: string; exitWhen?: string; followUp?: string; mediaIds?: string[] }[] }>();
  const list = (body.stages || []).slice(0, 20);
  if (list.some((st) => !st.name?.trim())) return c.json({ error: 'name_required', message: '每个步骤都要有名称' }, 400);
  const existing = await listStages(c.env, ws(c));
  const keepIds = new Set(list.map((st) => st.id).filter(Boolean));
  const validMedia = new Set((await listMedia(c.env, ws(c))).map((m) => m.id));
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const old of existing) {
    if (!keepIds.has(old.id)) {
      stmts.push(c.env.DB.prepare('UPDATE customers SET sop_stage_id = NULL WHERE sop_stage_id = ?').bind(old.id));
      stmts.push(c.env.DB.prepare('DELETE FROM sop_stages WHERE id = ?').bind(old.id));
    }
  }
  list.forEach((st, i) => {
    const media = JSON.stringify((st.mediaIds || []).filter((id) => validMedia.has(id)).slice(0, 5));
    const vals = [i, st.name!.trim().slice(0, 100), (st.goal || '').slice(0, 1000), (st.script || '').slice(0, 3000), (st.exitWhen || '').slice(0, 1000), media, (st.followUp || '').slice(0, 1000), t];
    if (st.id && existing.some((e) => e.id === st.id)) {
      stmts.push(
        c.env.DB.prepare('UPDATE sop_stages SET sort_order = ?, name = ?, goal = ?, script = ?, exit_when = ?, media_ids = ?, follow_up = ?, updated_at = ? WHERE id = ? AND workspace_id = ?').bind(
          ...vals, st.id, ws(c),
        ),
      );
    } else {
      stmts.push(
        c.env.DB.prepare(
          'INSERT INTO sop_stages (sort_order, name, goal, script, exit_when, media_ids, follow_up, updated_at, id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(...vals, newId('s_'), ws(c), t),
      );
    }
  });
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true, stages: (await listStages(c.env, ws(c))).map(stageOut) });
});

// ======================= 知识库 =======================
api.get('/kb', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, title, source_type, enabled, status, error, chunk_count, length(content) AS chars, created_at, updated_at FROM kb_documents WHERE workspace_id = ? ORDER BY created_at DESC',
  )
    .bind(ws(c))
    .all();
  return c.json({ documents: results });
});

api.get('/kb/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM kb_documents WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), ws(c)).first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ document: row });
});

api.post('/kb', async (c) => {
  const b = await c.req.json<{ title?: string; content?: string; sourceType?: string }>();
  const content = (b.content || '').trim();
  if (!content) return c.json({ error: 'empty', message: '内容是空的（扫描版 PDF 读不到文字）' }, 400);
  if (content.length > MAX_DOC_CHARS) return c.json({ error: 'too_long', message: `内容太长，最多 ${MAX_DOC_CHARS.toLocaleString()} 字，请拆成几份` }, 400);
  const id = newId('d_');
  const t = now();
  const type = ['text', 'pdf', 'docx'].includes(b.sourceType || '') ? b.sourceType! : 'text';
  await c.env.DB.prepare(
    'INSERT INTO kb_documents (id, workspace_id, title, source_type, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, ws(c), (b.title || '未命名资料').slice(0, 200), type, content, t, t)
    .run();
  const r = await indexDocument(c.env, ws(c), id, content);
  return c.json({ ok: true, id, ...r });
});

api.patch('/kb/:id', async (c) => {
  const b = await c.req.json<{ title?: string; content?: string; enabled?: boolean }>();
  const row = await c.env.DB.prepare('SELECT * FROM kb_documents WHERE id = ? AND workspace_id = ?')
    .bind(c.req.param('id'), ws(c))
    .first<{ id: string; title: string; content: string; enabled: number }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const content = b.content !== undefined ? b.content.trim() : row.content;
  if (content.length > MAX_DOC_CHARS) return c.json({ error: 'too_long', message: '内容太长' }, 400);
  await c.env.DB.prepare('UPDATE kb_documents SET title = ?, content = ?, enabled = ?, updated_at = ? WHERE id = ?')
    .bind(b.title?.slice(0, 200) ?? row.title, content, b.enabled === undefined ? row.enabled : b.enabled ? 1 : 0, now(), row.id)
    .run();
  if (b.content !== undefined && content !== row.content) await indexDocument(c.env, ws(c), row.id, content);
  return c.json({ ok: true });
});

api.post('/kb/:id/reindex', async (c) => {
  const row = await c.env.DB.prepare('SELECT id, content FROM kb_documents WHERE id = ? AND workspace_id = ?')
    .bind(c.req.param('id'), ws(c))
    .first<{ id: string; content: string }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, ...(await indexDocument(c.env, ws(c), row.id, row.content)) });
});

api.delete('/kb/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM kb_chunks WHERE document_id = ? AND workspace_id = ?').bind(id, ws(c)),
    c.env.DB.prepare('DELETE FROM kb_documents WHERE id = ? AND workspace_id = ?').bind(id, ws(c)),
  ]);
  return c.json({ ok: true });
});

// ======================= Bot 设定 + 测试聊天 =======================
api.get('/settings', async (c) => c.json({ settings: await loadSettings(c.env, ws(c)) }));

api.put('/settings', requireOwner, async (c) => {
  const s = mergeSettings(await c.req.json());
  await saveSettings(c.env, ws(c), s);
  return c.json({ ok: true, settings: s });
});

api.post('/test-chat', async (c) => {
  const b = await c.req.json<{
    messages?: { role: 'customer' | 'bot'; text: string }[];
    settings?: unknown;
    stageId?: string | null;
    sentMedia?: string[];
  }>();
  const history = (b.messages || []).slice(-30).filter((m) => m.text?.trim());
  const last = history.filter((m) => m.role === 'customer').at(-1);
  if (!last) return c.json({ error: 'empty', message: '先打一句顾客会说的话' }, 400);
  // 测试时可以用还没保存的设定
  const settings = b.settings && !c.get('user').demo ? mergeSettings(b.settings) : await loadSettings(c.env, ws(c));
  const { deepseekKey } = await loadSecrets(c.env, ws(c));
  if (!deepseekKey) return c.json({ error: 'no_key', message: '请先到「系统设定」填 DeepSeek API key' }, 400);

  const quota = await demoQuota(c.env, ws(c));
  if (!quota.allowed) return c.json({ error: 'demo_limit', message: DEMO_LIMIT_REPLY }, 429);

  const kw = matchesAny(last.text, [...settings.handoffKeywords, ...settings.forbiddenKeywords]);
  if (kw) return c.json({ reply: settings.handoffReply, handoffReason: `关键词：${kw}`, lead: null, toolLog: [], kb: [], media: [], stageId: b.stageId ?? null });

  try {
    if (quota.isDemo) await bumpUsage(c.env, ws(c));
    const sent = Array.isArray(b.sentMedia) ? b.sentMedia.map(String) : [];
    const r = await runAgent({
      env: c.env,
      workspaceId: ws(c),
      settings,
      apiKey: deepseekKey,
      history: historyToChat(history.map((m) => ({ role: m.role, text: m.text }))),
      query: history.filter((m) => m.role === 'customer').slice(-2).map((m) => m.text).join('\n'),
      customer: { name: '测试顾客', summary: '', stageId: b.stageId ?? null, sentMedia: sent },
    });
    const media = [...r.mediaToSend, ...stageMediaFor(r, b.stageId ?? null, sent)].slice(0, 4).map((m) => mediaOut(c.env, m));
    const stage = r.stages.find((st) => st.id === r.stageId);
    return c.json({
      reply: r.reply,
      handoffReason: r.handoffReason,
      lead: r.lead,
      toolLog: r.toolLog,
      kb: r.kb.map((k) => ({ title: k.title, score: Math.round(k.score * 100) / 100, text: k.text.slice(0, 200) })),
      media,
      stageId: r.stageId,
      stageName: stage?.name ?? null,
    });
  } catch (e) {
    return c.json({ error: 'llm_failed', message: (e as Error).message }, 502);
  }
});

// ======================= 模拟顾客 =======================
// 不用 Meta App：在后台扮演顾客，走跟真顾客一样的流程，只是信息不发去 Messenger。
api.get('/sim/customers', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM customers WHERE workspace_id = ? AND page_id = ? AND psid NOT LIKE '${SEED_PSID_PREFIX}%' ORDER BY created_at DESC LIMIT 50`)
    .bind(ws(c), simPageId(ws(c)))
    .all<CustomerRow>();
  return c.json({ customers: results.map(customerOut) });
});

api.post('/sim/customers', async (c) => {
  const b = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  if (c.get('user').demo) await trimDemoSims(c.env, ws(c)); // Demo：自动删掉最旧的，访客不会卡在上限
  const n = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM customers WHERE workspace_id = ? AND page_id = ? AND psid NOT LIKE '${SEED_PSID_PREFIX}%'`).bind(ws(c), simPageId(ws(c))).first<{ n: number }>();
  if ((n?.n ?? 0) >= 50) return c.json({ error: 'too_many', message: '模拟顾客最多 50 个，请先删除一些' }, 400);
  const { customer } = await getOrCreateCustomer(c.env, ws(c), simPageId(ws(c)), 'sim_' + newId());
  const name = (b.name || '').trim().slice(0, 60) || `模拟顾客 ${(n?.n ?? 0) + 1}`;
  await c.env.DB.prepare('UPDATE customers SET name = ? WHERE id = ?').bind(name, customer.id).run();
  return c.json({ ok: true, id: customer.id });
});

api.post('/sim/customers/:id/messages', async (c) => {
  const cust = await getCustomer(c.env, ws(c), c.req.param('id'));
  if (!cust || !isSimPage(cust.page_id) || cust.psid.startsWith(SEED_PSID_PREFIX)) return c.json({ error: 'not_found' }, 404);
  const { text } = await c.req.json<{ text?: string }>();
  const body = (text || '').trim().slice(0, 2000);
  if (!body) return c.json({ error: 'empty', message: '不能发空白信息' }, 400);
  await processJob(c.env, { kind: 'message', pageId: cust.page_id, psid: cust.psid, mid: 'sim.' + newId(), text: body, timestamp: now() });
  return c.json({ ok: true });
});

/** 模拟顾客发语音：body = 音频档本身。先转文字，再走跟真顾客一样的流程。 */
api.put('/sim/customers/:id/audio', async (c) => {
  const cust = await getCustomer(c.env, ws(c), c.req.param('id'));
  if (!cust || !isSimPage(cust.page_id)) return c.json({ error: 'not_found' }, 404);
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: 'empty', message: '档案是空的' }, 400);
  if (buf.byteLength > MAX_AUDIO_BYTES) return c.json({ error: 'too_big', message: '语音档太大，最多 8MB' }, 400);
  const settings = await loadSettings(c.env, ws(c));
  const tr = settings.voiceEnabled ? await transcribeBytes(c.env, buf, await voiceHint(c.env, ws(c), settings)) : null;
  await processJob(c.env, {
    kind: 'message',
    pageId: cust.page_id,
    psid: cust.psid,
    mid: 'sim.' + newId(),
    text: tr?.text ?? '[顾客发了语音]',
    timestamp: now(),
    // 转不到文字时带一个假网址，让流程走「听不了语音」那条路
    attachment: tr ? { type: 'audio', transcript: true, ms: tr.ms } : { type: 'audio', url: 'sim://failed' },
  });
  return c.json({ ok: true, transcript: tr?.text ?? null });
});

api.delete('/sim/customers/:id', async (c) => {
  const cust = await getCustomer(c.env, ws(c), c.req.param('id'));
  if (!cust || !isSimPage(cust.page_id) || cust.psid.startsWith(SEED_PSID_PREFIX)) return c.json({ error: 'not_found' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM leads WHERE customer_id = ?').bind(cust.id),
    c.env.DB.prepare('DELETE FROM handoffs WHERE customer_id = ?').bind(cust.id),
    c.env.DB.prepare('DELETE FROM messages WHERE customer_id = ?').bind(cust.id),
    c.env.DB.prepare('DELETE FROM customers WHERE id = ?').bind(cust.id),
  ]);
  return c.json({ ok: true });
});

// ======================= 自动跟进 =======================
/** 马上检查一次（平时由定时任务每 15 分钟跑）。测试时不用等。 */
api.post('/followups/run', async (c) => c.json({ ok: true, ...(await runFollowUps(c.env, ws(c))) }));

// ======================= 快捷回复 =======================
api.get('/quick-replies', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, title, text FROM quick_replies WHERE workspace_id = ? ORDER BY sort_order, created_at').bind(ws(c)).all();
  return c.json({ replies: results });
});

api.post('/quick-replies', async (c) => {
  const b = await c.req.json<{ title?: string; text?: string }>();
  const text = (b.text || '').trim().slice(0, 2000);
  if (!text) return c.json({ error: 'empty', message: '要填回复内容' }, 400);
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM quick_replies WHERE workspace_id = ?').bind(ws(c)).first<{ n: number }>();
  if ((n?.n ?? 0) >= 100) return c.json({ error: 'too_many', message: '快捷回复最多 100 条' }, 400);
  const id = newId('q_');
  await c.env.DB.prepare('INSERT INTO quick_replies (id, workspace_id, title, text, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, ws(c), (b.title || '').trim().slice(0, 60) || text.slice(0, 20), text, n?.n ?? 0, now())
    .run();
  return c.json({ ok: true, id });
});

api.patch('/quick-replies/:id', async (c) => {
  const b = await c.req.json<{ title?: string; text?: string }>();
  const row = await c.env.DB.prepare('SELECT title, text FROM quick_replies WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), ws(c)).first<{ title: string; text: string }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const text = b.text !== undefined ? b.text.trim().slice(0, 2000) : row.text;
  if (!text) return c.json({ error: 'empty', message: '要填回复内容' }, 400);
  await c.env.DB.prepare('UPDATE quick_replies SET title = ?, text = ? WHERE id = ?')
    .bind(b.title !== undefined ? b.title.trim().slice(0, 60) || text.slice(0, 20) : row.title, text, c.req.param('id'))
    .run();
  return c.json({ ok: true });
});

api.delete('/quick-replies/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM quick_replies WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), ws(c)).run();
  return c.json({ ok: true });
});

// ======================= 行业模板 =======================
api.get('/templates', (c) => c.json({ templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, summary: t.summary, stages: t.stages.map((s) => s.name) })) }));

api.post('/templates/:id/apply', requireOwner, async (c) => {
  const tpl = getTemplate(c.req.param('id') ?? '');
  if (!tpl) return c.json({ error: 'not_found' }, 404);
  const settings = await loadSettings(c.env, ws(c));
  const fill = (s: string) => s.replace(/\{business\}/g, settings.businessName);
  const next = mergeSettings({
    ...settings,
    botIdentity: fill(tpl.settings.botIdentity),
    greeting: fill(tpl.settings.greeting),
    unknownReply: tpl.settings.unknownReply,
    forbiddenTopics: tpl.settings.forbiddenTopics,
    forbiddenKeywords: tpl.settings.forbiddenKeywords,
  });
  await saveSettings(c.env, ws(c), next);
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE customers SET sop_stage_id = NULL, sop_stage_at = NULL WHERE workspace_id = ?').bind(ws(c)),
    c.env.DB.prepare('DELETE FROM sop_stages WHERE workspace_id = ?').bind(ws(c)),
    ...tpl.stages.map((st, i) =>
      c.env.DB.prepare(
        'INSERT INTO sop_stages (id, workspace_id, sort_order, name, goal, script, exit_when, media_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(newId('s_'), ws(c), i, st.name, st.goal, st.script, st.exit_when, '[]', t, t),
    ),
  ]);
  return c.json({ ok: true, settings: next });
});

// ======================= 系统设定 =======================
api.get('/system', async (c) => {
  const row = await c.env.DB.prepare('SELECT deepseek_key_enc, telegram_token_enc FROM bot_settings WHERE workspace_id = ?')
    .bind(ws(c))
    .first<{ deepseek_key_enc: string | null; telegram_token_enc: string | null }>();
  const page = await c.env.DB.prepare('SELECT page_id, name, created_at FROM fb_pages WHERE workspace_id = ? LIMIT 1').bind(ws(c)).first();
  const base = (c.env.APP_URL || new URL(c.req.url).origin).replace(/\/$/, '');
  return c.json({
    page,
    hasDeepseekKey: !!row?.deepseek_key_enc,
    hasTelegramToken: !!row?.telegram_token_enc,
    appUrl: (c.env.APP_URL || '').replace(/\/$/, ''),
    hasMediaStore: !!c.env.MEDIA,
    webhookUrl: `${base}/webhook`,
    privacyUrl: `${base}/privacy`,
    verifyTokenSet: !!c.env.META_VERIFY_TOKEN,
    appSecretSet: !!c.env.META_APP_SECRET,
    appIdSet: !!c.env.META_APP_ID,
  });
});

api.put('/system/page', requireOwner, async (c) => {
  const { pageToken } = await c.req.json<{ pageToken?: string }>();
  if (!pageToken?.trim()) return c.json({ error: 'empty', message: '请贴上 Page access token' }, 400);
  let info: { pageId: string; name: string };
  try {
    info = await connectPage(c.env, pageToken.trim());
  } catch (e) {
    return c.json({ error: 'meta_failed', message: `连接失败：${(e as Error).message}` }, 400);
  }
  const taken = await c.env.DB.prepare('SELECT workspace_id FROM fb_pages WHERE page_id = ?').bind(info.pageId).first<{ workspace_id: string }>();
  if (taken && taken.workspace_id !== ws(c)) return c.json({ error: 'page_taken', message: '这个 Page 已经连接到别的账号' }, 400);
  const enc = await encryptSecret(pageToken.trim(), c.env.ENCRYPTION_KEY);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM fb_pages WHERE workspace_id = ? AND page_id != ?').bind(ws(c), info.pageId),
    c.env.DB.prepare(
      `INSERT INTO fb_pages (page_id, workspace_id, name, page_token_enc, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(page_id) DO UPDATE SET name = excluded.name, page_token_enc = excluded.page_token_enc`,
    ).bind(info.pageId, ws(c), info.name, enc, now()),
  ]);
  return c.json({ ok: true, page: info });
});

async function ensureSettingsRow(c: { env: AppEnv['Bindings'] }, workspaceId: string) {
  const s = await loadSettings(c.env, workspaceId);
  await saveSettings(c.env, workspaceId, s);
}

api.put('/system/deepseek', requireOwner, async (c) => {
  const { apiKey } = await c.req.json<{ apiKey?: string }>();
  if (!apiKey?.trim()) return c.json({ error: 'empty', message: '请贴上 API key' }, 400);
  await ensureSettingsRow(c, ws(c));
  await c.env.DB.prepare('UPDATE bot_settings SET deepseek_key_enc = ? WHERE workspace_id = ?')
    .bind(await encryptSecret(apiKey.trim(), c.env.ENCRYPTION_KEY), ws(c))
    .run();
  return c.json({ ok: true });
});

api.put('/system/telegram', requireOwner, async (c) => {
  const { token } = await c.req.json<{ token?: string }>();
  if (!token?.trim()) return c.json({ error: 'empty', message: '请贴上 Telegram bot token' }, 400);
  await ensureSettingsRow(c, ws(c));
  await c.env.DB.prepare('UPDATE bot_settings SET telegram_token_enc = ? WHERE workspace_id = ?')
    .bind(await encryptSecret(token.trim(), c.env.ENCRYPTION_KEY), ws(c))
    .run();
  return c.json({ ok: true });
});

/** 帮你找 chat id：先在 Telegram 跟你的 bot 说一句话，再按这个。 */
api.post('/system/telegram/find-chat', async (c) => {
  const { telegramToken } = await loadSecrets(c.env, ws(c));
  if (!telegramToken) return c.json({ error: 'no_token', message: '先保存 Telegram bot token' }, 400);
  const res = await fetch(`https://api.telegram.org/bot${telegramToken}/getUpdates`);
  const data = (await res.json()) as { ok: boolean; result?: any[]; description?: string };
  if (!data.ok) return c.json({ error: 'tg_failed', message: data.description || 'Telegram 出错' }, 400);
  const chats = new Map<string, string>();
  for (const u of data.result || []) {
    const chat = u.message?.chat || u.channel_post?.chat || u.my_chat_member?.chat;
    if (chat?.id) chats.set(String(chat.id), chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '');
  }
  return c.json({ chats: [...chats].map(([id, name]) => ({ id, name })) });
});

api.post('/system/telegram/test', async (c) => {
  const settings = await loadSettings(c.env, ws(c));
  const { telegramToken } = await loadSecrets(c.env, ws(c));
  if (!telegramToken || !settings.telegramChatId) return c.json({ error: 'not_ready', message: '先保存 token 和 chat id' }, 400);
  try {
    await sendTelegram(telegramToken, settings.telegramChatId, '✅ Messenger AI 客服系统：Telegram 通知测试成功');
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: 'tg_failed', message: (e as Error).message }, 400);
  }
});

api.get('/stats', async (c) => {
  const since = now() - 7 * DAY;
  const r = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM customers WHERE workspace_id = ?1) AS customers,
       (SELECT COUNT(*) FROM messages WHERE workspace_id = ?1 AND role = 'customer' AND created_at > ?2) AS inbound7d,
       (SELECT COUNT(*) FROM messages WHERE workspace_id = ?1 AND role = 'bot' AND created_at > ?2) AS bot7d,
       (SELECT COUNT(*) FROM handoffs WHERE workspace_id = ?1 AND created_at > ?2) AS handoffs7d,
       (SELECT COUNT(*) FROM leads WHERE workspace_id = ?1 AND created_at > ?2) AS leads7d`,
  )
    .bind(ws(c), since)
    .first();
  return c.json({ stats: r, hour: HOUR });
});
