// 数据报表、AI 评测、Demo 账号管理。
import { Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { listStages, loadSecrets, loadSettings } from './db';
import { historyToChat, matchesAny, runAgent } from './bot';
import { chatCompletion } from './llm';
import { requireOwner } from './auth';
import { bumpUsage, demoQuota, DEMO_LIMIT_REPLY } from './demo';
import { cleanChecks, DEFAULT_EVAL_CASES, hasAnyCheck, mentionsPrice, type EvalCaseResult, type EvalCheckResult, type EvalChecks } from '../shared/evals';
import type { BotSettings } from '../shared/settings';
import { DAY, newId, now, parseJson } from './util';

export const insights = new Hono<AppEnv>();
const ws = (c: { get: (k: 'user') => { workspaceId: string } }) => c.get('user').workspaceId;

// ======================= 数据报表 =======================
insights.get('/reports', async (c) => {
  const days = [7, 14, 30].includes(Number(c.req.query('days'))) ? Number(c.req.query('days')) : 14;
  // tz = 浏览器的时区（分钟，马来西亚 = 480），用来把信息归到「哪一天」
  const tz = Math.max(-720, Math.min(840, Number(c.req.query('tz')) || 0)) * 60_000;
  const includeSim = c.req.query('sim') !== '0';
  const today = Math.floor((now() + tz) / DAY);
  const firstDay = today - days + 1;
  const since = firstDay * DAY - tz;
  const w = ws(c);
  // 不算模拟顾客时，只看真 FB Page 的顾客
  const cust = includeSim ? '' : ` AND customer_id IN (SELECT id FROM customers WHERE workspace_id = ?1 AND page_id NOT LIKE 'sim:%')`;
  const custC = includeSim ? '' : ` AND page_id NOT LIKE 'sim:%'`;

  const [perDay, totals, stageRows, stages, sources] = await Promise.all([
    c.env.DB.prepare(`SELECT CAST((created_at + ?3) / ${DAY} AS INTEGER) AS d, role, COUNT(*) AS n FROM messages WHERE workspace_id = ?1 AND created_at >= ?2${cust} GROUP BY d, role`)
      .bind(w, since, tz)
      .all<{ d: number; role: string; n: number }>(),
    c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(DISTINCT customer_id) FROM messages WHERE workspace_id = ?1 AND role = 'customer' AND created_at >= ?2${cust}) AS active,
         (SELECT COUNT(*) FROM customers WHERE workspace_id = ?1 AND created_at >= ?2 AND last_inbound_at IS NOT NULL${custC}) AS newCustomers,
         (SELECT COUNT(*) FROM leads WHERE workspace_id = ?1 AND created_at >= ?2${cust}) AS leads,
         (SELECT COUNT(*) FROM handoffs WHERE workspace_id = ?1 AND created_at >= ?2${cust}) AS handoffs,
         (SELECT COUNT(*) FROM (
            SELECT customer_id FROM handoffs WHERE workspace_id = ?1 AND created_at >= ?2${cust}
            UNION SELECT customer_id FROM messages WHERE workspace_id = ?1 AND role = 'human' AND created_at >= ?2${cust}
          ) WHERE customer_id IN (SELECT customer_id FROM messages WHERE workspace_id = ?1 AND role = 'customer' AND created_at >= ?2)) AS withHuman,
         (SELECT COUNT(*) FROM messages WHERE workspace_id = ?1 AND role = 'bot' AND created_at >= ?2 AND json_extract(trace, '$.type') = 'ai'${cust}) AS aiReplies,
         (SELECT AVG(json_extract(trace, '$.ms')) FROM messages WHERE workspace_id = ?1 AND role = 'bot' AND created_at >= ?2 AND json_extract(trace, '$.type') = 'ai'${cust}) AS avgMs,
         (SELECT SUM(json_extract(trace, '$.usage.prompt') + json_extract(trace, '$.usage.completion')) FROM messages WHERE workspace_id = ?1 AND role = 'bot' AND created_at >= ?2 AND json_extract(trace, '$.type') = 'ai'${cust}) AS tokens,
         (SELECT COUNT(*) FROM messages WHERE workspace_id = ?1 AND role = 'customer' AND created_at >= ?2 AND attachment LIKE '%"transcript":true%'${cust}) AS voice,
         (SELECT COUNT(*) FROM messages WHERE workspace_id = ?1 AND role = 'bot' AND created_at >= ?2 AND json_extract(trace, '$.type') = 'followup'${cust}) AS followUps`,
    )
      .bind(w, since)
      .first<Record<string, number | null>>(),
    c.env.DB.prepare(
      `SELECT sop_stage_id AS id, COUNT(*) AS n, SUM(CASE WHEN EXISTS (SELECT 1 FROM leads l WHERE l.customer_id = customers.id) THEN 1 ELSE 0 END) AS leads
       FROM customers WHERE workspace_id = ?1 AND last_inbound_at >= ?2${custC} GROUP BY sop_stage_id`,
    )
      .bind(w, since)
      .all<{ id: string | null; n: number; leads: number }>(),
    listStages(c.env, w),
    c.env.DB.prepare(`SELECT source, COUNT(*) AS n FROM handoffs WHERE workspace_id = ?1 AND created_at >= ?2${cust} GROUP BY source`).bind(w, since).all<{ source: string; n: number }>(),
  ]);

  const daily = Array.from({ length: days }, (_, i) => ({ day: (firstDay + i) * DAY, customer: 0, bot: 0, human: 0 }));
  for (const r of perDay.results) {
    const row = daily[r.d - firstDay];
    if (row && (r.role === 'customer' || r.role === 'bot' || r.role === 'human')) row[r.role] = r.n;
  }

  // 漏斗：我们只记顾客「现在」在哪一步，所以「到过第 N 步」= 现在在第 N 步或更后面
  const at = new Map(stageRows.results.map((r) => [r.id, r]));
  let later = 0;
  const funnel = stages
    .map((st) => ({ id: st.id, name: st.name, here: at.get(st.id)?.n ?? 0, leads: at.get(st.id)?.leads ?? 0, reached: 0 }))
    .reverse()
    .map((f) => ({ ...f, reached: (later += f.here) }))
    .reverse();

  const active = totals?.active ?? 0;
  const withHuman = Math.min(active, totals?.withHuman ?? 0);
  return c.json({
    days,
    daily,
    totals: {
      active,
      newCustomers: totals?.newCustomers ?? 0,
      inbound: daily.reduce((s, d) => s + d.customer, 0),
      botReplies: daily.reduce((s, d) => s + d.bot, 0),
      humanReplies: daily.reduce((s, d) => s + d.human, 0),
      leads: totals?.leads ?? 0,
      handoffs: totals?.handoffs ?? 0,
      withHuman,
      botOnly: active - withHuman,
      aiReplies: totals?.aiReplies ?? 0,
      avgMs: Math.round(totals?.avgMs ?? 0),
      tokens: totals?.tokens ?? 0,
      voice: totals?.voice ?? 0,
      followUps: totals?.followUps ?? 0,
    },
    funnel,
    noStage: at.get(null)?.n ?? 0,
    handoffSources: Object.fromEntries(sources.results.map((r) => [r.source, r.n])),
  });
});

// ======================= AI 评测 =======================
interface CaseRow {
  id: string;
  question: string;
  checks: string;
  sort_order: number;
}
const caseOut = (r: CaseRow) => ({ id: r.id, question: r.question, checks: parseJson<EvalChecks>(r.checks, {}) });

insights.get('/eval', async (c) => {
  const [cases, runs] = await Promise.all([
    c.env.DB.prepare('SELECT id, question, checks, sort_order FROM eval_cases WHERE workspace_id = ? ORDER BY sort_order, created_at').bind(ws(c)).all<CaseRow>(),
    c.env.DB.prepare('SELECT id, model, total, passed, results, created_at AS createdAt FROM eval_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 10').bind(ws(c)).all<Record<string, unknown>>(),
  ]);
  return c.json({
    cases: cases.results.map(caseOut),
    // 只有最新一次带每题的详情，其它只给分数
    runs: runs.results.map((r, i) => ({ id: r.id, model: r.model, total: r.total, passed: r.passed, createdAt: r.createdAt, results: i === 0 ? parseJson<EvalCaseResult[]>(r.results as string, []) : undefined })),
  });
});

insights.post('/eval/cases', requireOwner, async (c) => {
  const b = await c.req.json<{ question?: string; checks?: unknown; defaults?: boolean }>();
  const t = now();
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM eval_cases WHERE workspace_id = ?').bind(ws(c)).first<{ n: number }>();
  const count = n?.n ?? 0;
  if (b.defaults) {
    if (count + DEFAULT_EVAL_CASES.length > 50) return c.json({ error: 'too_many', message: '测试题最多 50 题' }, 400);
    await c.env.DB.batch(
      DEFAULT_EVAL_CASES.map((d, i) =>
        c.env.DB.prepare('INSERT INTO eval_cases (id, workspace_id, question, checks, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(newId('e_'), ws(c), d.question, JSON.stringify(d.checks), count + i, t, t),
      ),
    );
    return c.json({ ok: true });
  }
  const question = (b.question || '').trim().slice(0, 1000);
  const checks = cleanChecks(b.checks);
  if (!question) return c.json({ error: 'empty', message: '要填顾客会问的问题' }, 400);
  if (!hasAnyCheck(checks)) return c.json({ error: 'no_checks', message: '至少要设一个期望条件' }, 400);
  if (count >= 50) return c.json({ error: 'too_many', message: '测试题最多 50 题' }, 400);
  const id = newId('e_');
  await c.env.DB.prepare('INSERT INTO eval_cases (id, workspace_id, question, checks, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, ws(c), question, JSON.stringify(checks), count, t, t)
    .run();
  return c.json({ ok: true, id });
});

insights.patch('/eval/cases/:id', requireOwner, async (c) => {
  const b = await c.req.json<{ question?: string; checks?: unknown }>();
  const question = (b.question || '').trim().slice(0, 1000);
  const checks = cleanChecks(b.checks);
  if (!question) return c.json({ error: 'empty', message: '要填顾客会问的问题' }, 400);
  if (!hasAnyCheck(checks)) return c.json({ error: 'no_checks', message: '至少要设一个期望条件' }, 400);
  await c.env.DB.prepare('UPDATE eval_cases SET question = ?, checks = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .bind(question, JSON.stringify(checks), now(), c.req.param('id'), ws(c))
    .run();
  return c.json({ ok: true });
});

insights.delete('/eval/cases/:id', requireOwner, async (c) => {
  await c.env.DB.prepare('DELETE FROM eval_cases WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), ws(c)).run();
  return c.json({ ok: true });
});

/** 开始一次评测。网页会一题一题叫下面那个接口（免费版每次请求能做的事有限，不能一次跑完）。 */
insights.post('/eval/runs', async (c) => {
  const settings = await loadSettings(c.env, ws(c));
  const id = newId('r_');
  await c.env.DB.prepare('INSERT INTO eval_runs (id, workspace_id, model, created_at) VALUES (?, ?, ?, ?)').bind(id, ws(c), settings.model, now()).run();
  // 只留最近 20 次
  await c.env.DB.prepare('DELETE FROM eval_runs WHERE workspace_id = ?1 AND id NOT IN (SELECT id FROM eval_runs WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT 20)').bind(ws(c)).run();
  return c.json({ ok: true, id });
});

insights.post('/eval/runs/:id/cases/:caseId', async (c) => {
  const run = await c.env.DB.prepare('SELECT id, results FROM eval_runs WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), ws(c)).first<{ id: string; results: string }>();
  const row = await c.env.DB.prepare('SELECT id, question, checks, sort_order FROM eval_cases WHERE id = ? AND workspace_id = ?').bind(c.req.param('caseId'), ws(c)).first<CaseRow>();
  if (!run || !row) return c.json({ error: 'not_found' }, 404);
  const { deepseekKey } = await loadSecrets(c.env, ws(c));
  if (!deepseekKey) return c.json({ error: 'no_key', message: '请先到「系统设定」填 DeepSeek API key' }, 400);
  const quota = await demoQuota(c.env, ws(c));
  if (!quota.allowed) return c.json({ error: 'demo_limit', message: DEMO_LIMIT_REPLY }, 429);

  const settings = await loadSettings(c.env, ws(c));
  const result = await runEvalCase(c.env, ws(c), settings, deepseekKey, caseOut(row));
  if (quota.isDemo) await bumpUsage(c.env, ws(c));

  const results = parseJson<EvalCaseResult[]>(run.results, []).filter((r) => r.caseId !== row.id);
  results.push(result);
  await c.env.DB.prepare('UPDATE eval_runs SET results = ?, total = ?, passed = ? WHERE id = ?')
    .bind(JSON.stringify(results), results.length, results.filter((r) => r.pass).length, run.id)
    .run();
  return c.json({ ok: true, result });
});

/** 跑一题：跟真顾客一样走关键词 → AI，但不写数据库、不发信息。然后逐项检查。 */
export async function runEvalCase(env: Env, workspaceId: string, settings: BotSettings, apiKey: string, cs: { id: string; question: string; checks: EvalChecks }): Promise<EvalCaseResult> {
  const started = Date.now();
  const out: EvalCaseResult = { caseId: cs.id, question: cs.question, reply: '', pass: false, checks: [], handoffReason: null, tools: [], ms: 0 };
  let savedLead = false;
  try {
    const kw = matchesAny(cs.question, [...settings.handoffKeywords, ...settings.forbiddenKeywords]);
    if (kw) {
      out.reply = settings.handoffReply;
      out.handoffReason = `关键词：${kw}`;
    } else {
      const r = await runAgent({
        env,
        workspaceId,
        settings,
        apiKey,
        history: historyToChat([{ role: 'customer', text: cs.question }]),
        query: cs.question,
        customer: { name: '测试顾客', summary: '' },
      });
      out.reply = r.reply;
      out.handoffReason = r.handoffReason;
      out.tools = r.toolLog.map((x) => x.name);
      savedLead = !!r.lead;
    }

    const ck = cs.checks;
    const low = out.reply.toLowerCase();
    const add = (label: string, pass: boolean, detail?: string) => out.checks.push({ label, pass, detail });
    if (ck.handoff === 'must') add('handoff:must', !!out.handoffReason, out.handoffReason ?? undefined);
    if (ck.handoff === 'mustNot') add('handoff:mustNot', !out.handoffReason, out.handoffReason ?? undefined);
    for (const w of ck.include ?? []) add(`include:${w}`, low.includes(w.toLowerCase()));
    if (ck.includeAny?.length) add(`includeAny:${ck.includeAny.join(' / ')}`, ck.includeAny.some((w) => low.includes(w.toLowerCase())));
    for (const w of ck.exclude ?? []) add(`exclude:${w}`, !low.includes(w.toLowerCase()));
    if (ck.noPrice) add('noPrice', !mentionsPrice(out.reply));
    if (ck.saveLead) add('saveLead', savedLead);
    if (ck.judge) out.checks.push(await judge(settings, apiKey, cs.question, out.reply, ck.judge));
    out.pass = out.checks.length > 0 && out.checks.every((x) => x.pass);
  } catch (e) {
    out.error = (e as Error).message.slice(0, 300);
  }
  out.ms = Date.now() - started;
  return out;
}

/** 用 AI 当评审：这句回复有没有符合标准。 */
async function judge(settings: BotSettings, apiKey: string, question: string, reply: string, criterion: string): Promise<EvalCheckResult> {
  const msg = await chatCompletion({
    baseUrl: settings.llmBaseUrl,
    apiKey,
    model: settings.model,
    temperature: 0,
    maxTokens: 200,
    messages: [
      {
        role: 'system',
        content:
          '你是严格的客服质检员。根据「标准」判断「客服回复」是否合格。只看回复本身有没有符合标准，不要评价别的。只输出 JSON：{"pass": true 或 false, "reason": "一句话原因"}',
      },
      { role: 'user', content: `顾客说：${question}\n\n客服回复：${reply || '（没有回复）'}\n\n标准：${criterion}` },
    ],
  });
  const m = (msg.content || '').match(/\{[\s\S]*\}/);
  const v = parseJson<{ pass?: unknown; reason?: unknown }>(m?.[0], {});
  return { label: `judge:${criterion}`, pass: v.pass === true, detail: typeof v.reason === 'string' ? v.reason.slice(0, 200) : (msg.content || '').slice(0, 200) };
}
