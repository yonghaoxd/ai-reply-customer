import type { Env } from './env';
import { loadSecrets, loadSettings } from './db';

export async function sendTelegram(token: string, chatId: string, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!data.ok) throw new Error(data.description || `Telegram ${res.status}`);
}

/** 通知老板/员工。失败只记 log，不影响 bot。 */
export async function notify(env: Env, workspaceId: string, text: string) {
  try {
    const settings = await loadSettings(env, workspaceId);
    if (!settings.telegramEnabled || !settings.telegramChatId) return;
    const { telegramToken } = await loadSecrets(env, workspaceId);
    if (!telegramToken) return;
    await sendTelegram(telegramToken, settings.telegramChatId, text);
  } catch (e) {
    console.warn('telegram notify failed', (e as Error).message);
  }
}

export function inboxLink(env: Env, customerId: string) {
  return `${(env.APP_URL || '').replace(/\/$/, '')}/#/inbox/${customerId}`;
}
