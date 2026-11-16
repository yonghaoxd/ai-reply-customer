// 产品图片 / 视频：档案存在 Workers KV（免费版不用绑卡），资料存在 D1。
// Meta 发图片时会来 /media/<key> 取档案，所以这个网址是公开的（key 是随机的，猜不到）。
import type { Context } from 'hono';
import type { AppEnv, Env } from './env';
import { sendAttachment, MetaError } from './meta';
import { addMessage, type CustomerRow, type MediaRow } from './db';
import { newId, now, parseJson } from './util';

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // KV 单个值上限，也是 Messenger 附件上限
export const ALLOWED_MIME: Record<string, { kind: 'image' | 'video'; ext: string }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/gif': { kind: 'image', ext: 'gif' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
};

export function mediaUrl(env: Env, kvKey: string) {
  return `${(env.APP_URL || '').replace(/\/$/, '')}/media/${kvKey}`;
}

/** 公开取档案 */
export async function serveMedia(c: Context<AppEnv>) {
  const key = c.req.param('key') || '';
  if (!/^[a-z0-9]+\.[a-z0-9]+$/.test(key)) return c.text('Not found', 404);
  const obj = await c.env.MEDIA.getWithMetadata<{ mime: string }>(key, { type: 'stream' });
  if (!obj.value) return c.text('Not found', 404);
  return new Response(obj.value, {
    headers: {
      'Content-Type': obj.metadata?.mime || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

/** 上传（后台）：PUT /api/media?productId=&title=，body = 档案本身 */
export async function uploadMedia(c: Context<AppEnv>) {
  const ws = c.get('user').workspaceId;
  const mime = (c.req.header('content-type') || '').split(';')[0].trim().toLowerCase();
  const info = ALLOWED_MIME[mime];
  if (!info) return c.json({ error: 'bad_type', message: '只支持 JPG / PNG / GIF / WEBP 图片和 MP4 视频' }, 400);
  const declared = Number(c.req.header('content-length') || 0);
  if (declared > MAX_MEDIA_BYTES) return c.json({ error: 'too_big', message: '档案太大，最多 25MB' }, 400);
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: 'empty', message: '档案是空的' }, 400);
  if (buf.byteLength > MAX_MEDIA_BYTES) return c.json({ error: 'too_big', message: '档案太大，最多 25MB' }, 400);

  const productId = c.req.query('productId') || null;
  if (productId) {
    const p = await c.env.DB.prepare('SELECT 1 FROM products WHERE id = ? AND workspace_id = ?').bind(productId, ws).first();
    if (!p) return c.json({ error: 'bad_product' }, 400);
  }
  const id = newId('md_');
  const kvKey = `${newId()}.${info.ext}`;
  await c.env.MEDIA.put(kvKey, buf, { metadata: { mime } });
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM media WHERE workspace_id = ? AND product_id IS ?').bind(ws, productId).first<{ n: number }>();
  await c.env.DB.prepare(
    'INSERT INTO media (id, workspace_id, product_id, kind, title, kv_key, mime, size, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, ws, productId, info.kind, (c.req.query('title') || '').slice(0, 200), kvKey, mime, buf.byteLength, count?.n ?? 0, now())
    .run();
  return c.json({ ok: true, id, url: mediaUrl(c.env, kvKey) });
}

export async function deleteMedia(env: Env, workspaceId: string, id: string) {
  const row = await env.DB.prepare('SELECT kv_key FROM media WHERE id = ? AND workspace_id = ?').bind(id, workspaceId).first<{ kv_key: string }>();
  if (!row) return false;
  await env.MEDIA.delete(row.kv_key);
  await env.DB.prepare('DELETE FROM media WHERE id = ?').bind(id).run();
  // 从 SOP 步骤里拿掉
  const { results } = await env.DB.prepare('SELECT id, media_ids FROM sop_stages WHERE workspace_id = ?').bind(workspaceId).all<{ id: string; media_ids: string }>();
  for (const s of results) {
    const ids = parseJson<string[]>(s.media_ids, []);
    if (ids.includes(id)) {
      await env.DB.prepare('UPDATE sop_stages SET media_ids = ? WHERE id = ?').bind(JSON.stringify(ids.filter((x) => x !== id)), s.id).run();
    }
  }
  return true;
}

/**
 * 发一个媒体给顾客，并记录到对话和顾客的「已发过」清单。
 * role = 'bot' 或 'human'（后台员工发的）。返回是否成功。
 */
export async function sendMediaToCustomer(
  env: Env,
  pageToken: string,
  customer: CustomerRow,
  m: MediaRow,
  role: 'bot' | 'human',
  opts: { userId?: string; humanAgent?: boolean } = {},
): Promise<boolean> {
  let res: { messageId: string | null; attachmentId: string | null } | null = null;
  if (m.fb_attachment_id) {
    try {
      res = await sendAttachment(env, pageToken, customer.psid, m.kind, { attachmentId: m.fb_attachment_id }, opts.humanAgent);
    } catch (e) {
      // attachment_id 失效（换了 Page 等）→ 改用网址再发一次
      if (!(e instanceof MetaError)) throw e;
      res = null;
    }
  }
  if (!res) {
    res = await sendAttachment(env, pageToken, customer.psid, m.kind, { url: mediaUrl(env, m.kv_key) }, opts.humanAgent);
    if (res.attachmentId) await env.DB.prepare('UPDATE media SET fb_attachment_id = ? WHERE id = ?').bind(res.attachmentId, m.id).run();
  }
  const label = `[${m.kind === 'image' ? '图片' : '视频'}] ${m.title || ''}`.trim();
  await addMessage(env, customer, role, label, {
    mid: res.messageId,
    userId: opts.userId ?? null,
    attachment: { type: m.kind, mediaId: m.id, url: mediaUrl(env, m.kv_key), title: m.title },
  });
  const sent = parseJson<string[]>(customer.sent_media, []);
  if (!sent.includes(m.id)) {
    sent.push(m.id);
    customer.sent_media = JSON.stringify(sent.slice(-100));
    await env.DB.prepare('UPDATE customers SET sent_media = ? WHERE id = ?').bind(customer.sent_media, customer.id).run();
  }
  return true;
}
