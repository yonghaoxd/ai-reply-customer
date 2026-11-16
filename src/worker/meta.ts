// Meta Graph API：发信息、取顾客名字、连接 Page。
import type { Env } from './env';

const graph = (env: Env) => `${env.GRAPH_BASE || 'https://graph.facebook.com'}/${env.GRAPH_VERSION || 'v23.0'}`;

/** 模拟顾客用的假 token：不会真的呼叫 Meta，只把信息存进系统。 */
export const SIM_TOKEN = 'SIM';
const simId = () => 'sim.' + crypto.randomUUID();

export class MetaError extends Error {
  constructor(message: string, public code?: number, public subcode?: number) {
    super(message);
  }
}

async function call(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new MetaError(e.message || `Graph API ${res.status}`, e.code, e.error_subcode);
  }
  return data;
}

/** Messenger 单条信息最多 2000 字，太长就拆开发。 */
export function splitForMessenger(text: string, max = 1900): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * 发文字给顾客。返回每段的 message_id（用来识别之后收到的 echo）。
 * humanAgent = true 时使用 HUMAN_AGENT tag（需要 Meta 批准 Human Agent 权限，可在 24 小时后 7 天内回复）。
 */
export async function sendText(env: Env, pageToken: string, psid: string, text: string, humanAgent = false): Promise<string[]> {
  if (pageToken === SIM_TOKEN) return [simId()];
  const ids: string[] = [];
  for (const part of splitForMessenger(text)) {
    const body: Record<string, unknown> = {
      recipient: { id: psid },
      message: { text: part },
      messaging_type: humanAgent ? 'MESSAGE_TAG' : 'RESPONSE',
    };
    if (humanAgent) body.tag = 'HUMAN_AGENT';
    const data = await call(`${graph(env)}/me/messages?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (data.message_id) ids.push(String(data.message_id));
  }
  return ids;
}

/**
 * 发图片 / 视频。第一次用 url（Meta 会来我们的 /media 网址取档案），
 * 并要求 Meta 给一个可重用的 attachment_id，之后直接用 id 发，更快也不用再下载。
 */
export async function sendAttachment(
  env: Env,
  pageToken: string,
  psid: string,
  type: 'image' | 'video',
  source: { url: string } | { attachmentId: string },
  humanAgent = false,
): Promise<{ messageId: string | null; attachmentId: string | null }> {
  if (pageToken === SIM_TOKEN) return { messageId: simId(), attachmentId: null };
  const payload = 'url' in source ? { url: source.url, is_reusable: true } : { attachment_id: source.attachmentId };
  const body: Record<string, unknown> = {
    recipient: { id: psid },
    message: { attachment: { type, payload } },
    messaging_type: humanAgent ? 'MESSAGE_TAG' : 'RESPONSE',
  };
  if (humanAgent) body.tag = 'HUMAN_AGENT';
  const data = await call(`${graph(env)}/me/messages?access_token=${encodeURIComponent(pageToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    messageId: data.message_id ? String(data.message_id) : null,
    attachmentId: data.attachment_id ? String(data.attachment_id) : null,
  };
}

export async function sendTypingOn(env: Env, pageToken: string, psid: string) {
  if (pageToken === SIM_TOKEN) return;
  try {
    await call(`${graph(env)}/me/messages?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, sender_action: 'typing_on' }),
    });
  } catch {
    /* 不重要 */
  }
}

/** 取顾客名字和头像（没有权限时返回 null，不影响回复）。 */
export async function getProfile(env: Env, pageToken: string, psid: string) {
  if (pageToken === SIM_TOKEN) return null;
  try {
    const d = await call(`${graph(env)}/${psid}?fields=first_name,last_name,name,profile_pic&access_token=${encodeURIComponent(pageToken)}`);
    const name = d.name || [d.first_name, d.last_name].filter(Boolean).join(' ');
    return { name: String(name || ''), pic: d.profile_pic ? String(d.profile_pic) : null };
  } catch {
    return null;
  }
}

/** 验证 Page token，并把这个 Page 订阅到我们的 app 的 webhook。 */
export async function connectPage(env: Env, pageToken: string) {
  const me = await call(`${graph(env)}/me?fields=id,name&access_token=${encodeURIComponent(pageToken)}`);
  const pageId = String(me.id);
  await call(
    `${graph(env)}/${pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_echoes&access_token=${encodeURIComponent(pageToken)}`,
    { method: 'POST' },
  );
  return { pageId, name: String(me.name || '') };
}
