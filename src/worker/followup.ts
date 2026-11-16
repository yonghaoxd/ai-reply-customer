// 自动跟进：顾客没回复时，在 24 小时窗口内由 bot 主动跟进（最多 2 次）。
// 由定时任务每 15 分钟检查一次，所以实际发出时间会比设定晚最多 15 分钟。
import type { Env } from './env';
import type { BotSettings } from '../shared/settings';
import { addMessage, getPage, listStages, loadSettings, type CustomerRow } from './db';
import { sendText } from './meta';
import { HOUR, now } from './util';

const MIN = 60_000;
const WINDOW = 24 * HOUR - 10 * MIN; // 留 10 分钟余量，不要压线
const MAX_PER_RUN = 40;

/** 这个顾客现在该不该跟进？该的话返回第几次（1 或 2）。 */
export function dueFollowUp(
  s: BotSettings,
  c: Pick<CustomerRow, 'last_inbound_at' | 'last_message_at' | 'follow_up_count' | 'bot_paused' | 'needs_human'>,
  lastRole: string | null,
  hasLead: boolean,
  t = now(),
): 1 | 2 | null {
  if (!s.botEnabled || !s.followUpEnabled || s.followUpCount < 1) return null;
  if (c.bot_paused || c.needs_human || hasLead) return null;
  if (!c.last_inbound_at || lastRole !== 'bot') return null; // 最后一句要是 bot 说的（真人说的不跟进）
  if (c.follow_up_count >= s.followUpCount) return null;
  const since = t - c.last_inbound_at;
  if (since >= WINDOW) return null;
  if (c.follow_up_count === 0) return since >= s.followUpMinutes1 * MIN ? 1 : null;
  // 第二次：还要离上一条信息至少 30 分钟，避免连着发
  return since >= s.followUpMinutes2 * MIN && t - (c.last_message_at ?? 0) >= 30 * MIN ? 2 : null;
}

export async function runFollowUps(env: Env, onlyWorkspace?: string): Promise<{ checked: number; sent: number }> {
  const t = now();
  const { results } = await env.DB.prepare(
    `SELECT c.*,
       (SELECT role FROM messages m WHERE m.customer_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_role,
       (SELECT 1 FROM leads l WHERE l.customer_id = c.id) AS has_lead
     FROM customers c
     WHERE c.bot_paused = 0 AND c.needs_human = 0 AND c.follow_up_count < 2
       AND c.last_inbound_at > ?1 ${onlyWorkspace ? 'AND c.workspace_id = ?2' : ''}
     ORDER BY c.last_inbound_at ASC LIMIT 200`,
  )
    .bind(...(onlyWorkspace ? [t - WINDOW, onlyWorkspace] : [t - WINDOW]))
    .all<CustomerRow & { last_role: string | null; has_lead: number | null }>();

  const settingsCache = new Map<string, BotSettings>();
  const stageCache = new Map<string, Awaited<ReturnType<typeof listStages>>>();
  let sent = 0;
  for (const c of results) {
    if (sent >= MAX_PER_RUN) break;
    let s = settingsCache.get(c.workspace_id);
    if (!s) settingsCache.set(c.workspace_id, (s = await loadSettings(env, c.workspace_id)));
    const n = dueFollowUp(s, c, c.last_role, !!c.has_lead, t);
    if (!n) continue;

    let stages = stageCache.get(c.workspace_id);
    if (!stages) stageCache.set(c.workspace_id, (stages = await listStages(env, c.workspace_id)));
    const stage = stages.find((st) => st.id === c.sop_stage_id);
    // 第一次：优先用这个 SOP 步骤的跟进话术；第二次：用「最后一次」的话术
    const text = (n === 1 ? stage?.follow_up?.trim() || s.followUpText : s.followUpText2).trim();
    if (!text) continue;

    // 先把次数加上去再发：就算发送后出错，也不会重复发
    const claim = await env.DB.prepare('UPDATE customers SET follow_up_count = ? WHERE id = ? AND follow_up_count = ?')
      .bind(n, c.id, c.follow_up_count)
      .run();
    if (!claim.meta.changes) continue;
    try {
      const page = await getPage(env, c.page_id);
      if (!page?.token) continue;
      const ids = await sendText(env, page.token, c.psid, text);
      await addMessage(env, c, 'bot', text, { mid: ids[0] ?? null, trace: { type: 'followup', n, stage: stage?.name ?? null } });
      sent++;
    } catch (e) {
      console.error('follow-up failed', c.id, (e as Error).message);
    }
  }
  return { checked: results.length, sent };
}
