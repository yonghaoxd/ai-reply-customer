// Meta webhook：验证 → 拆成工作放进队列 → 马上回 200。
import type { Context } from 'hono';
import type { AppEnv, InboundJob } from './env';
import { verifyMetaSignature } from './crypto';

export function verifyWebhook(c: Context<AppEnv>) {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge') ?? '';
  if (mode === 'subscribe' && token && c.env.META_VERIFY_TOKEN && token === c.env.META_VERIFY_TOKEN) {
    return c.text(challenge, 200);
  }
  return c.text('Forbidden', 403);
}

function describeAttachments(atts: any[] | undefined, who = '顾客'): string {
  if (!atts?.length) return '';
  const names: Record<string, string> = { image: '图片', video: '视频', audio: '语音', file: '文件', location: '位置', fallback: '链接' };
  return atts.map((a) => `[${who}发了${names[a?.type] || '附件'}]`).join(' ');
}

function firstAttachment(atts: any[] | undefined) {
  const a = atts?.find((x) => x?.type === 'audio' && x?.payload?.url) ?? atts?.find((x) => x?.payload?.url);
  return a ? { type: String(a.type), url: String(a.payload.url) } : undefined;
}

export function extractJobs(payload: any): InboundJob[] {
  const jobs: InboundJob[] = [];
  if (payload?.object !== 'page') return jobs;
  for (const entry of payload.entry ?? []) {
    const pageId = String(entry.id ?? '');
    for (const ev of entry.messaging ?? []) {
      const ts = Number(ev.timestamp) || Date.now();
      const msg = ev.message;
      if (msg?.is_echo) {
        const text = (msg.text || describeAttachments(msg.attachments, '专页')).trim();
        if (!text || !msg.mid) continue;
        jobs.push({
          kind: 'echo',
          pageId,
          psid: String(ev.recipient?.id ?? ''),
          mid: String(msg.mid),
          text,
          appId: msg.app_id != null ? String(msg.app_id) : undefined,
          timestamp: ts,
        });
        continue;
      }
      if (msg && msg.mid) {
        const text = (msg.text || describeAttachments(msg.attachments)).trim();
        if (!text) continue;
        jobs.push({ kind: 'message', pageId, psid: String(ev.sender?.id ?? ''), mid: String(msg.mid), text, timestamp: ts, attachment: firstAttachment(msg.attachments) });
        continue;
      }
      if (ev.postback) {
        // 按钮（例如 Get Started）当作顾客打了按钮上的字
        const text = String(ev.postback.title || ev.postback.payload || '').trim();
        if (!text) continue;
        const mid = String(ev.postback.mid || `pb_${ev.sender?.id}_${ts}`);
        jobs.push({ kind: 'message', pageId, psid: String(ev.sender?.id ?? ''), mid, text, timestamp: ts });
      }
    }
  }
  return jobs.filter((j) => j.pageId && j.psid);
}

export async function receiveWebhook(c: Context<AppEnv>) {
  const raw = await c.req.text();
  const ok = await verifyMetaSignature(raw, c.req.header('x-hub-signature-256') ?? null, c.env.META_APP_SECRET);
  if (!ok) return c.text('Invalid signature', 401);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.text('Bad JSON', 400);
  }
  const jobs = extractJobs(payload);
  if (jobs.length) {
    // 队列一次最多 100 条
    for (let i = 0; i < jobs.length; i += 100) {
      await c.env.INBOUND.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })));
    }
  }
  return c.text('EVENT_RECEIVED', 200);
}
