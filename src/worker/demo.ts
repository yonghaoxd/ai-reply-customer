// 公开 Demo 站：另外部署的一个 worker，有自己的数据库，里面只有虚构的示范资料。
// 访客不用登入，只能看 + 用模拟顾客聊天 + 跑评测。AI 用 Demo 专用的 key，每天有次数上限。
// 你自己用的站（真顾客、真 key）是另一个 worker + 另一个数据库，两边完全碰不到。
import type { Env } from './env';
import { hashPassword, randomToken } from './crypto';
import { saveSettings, simPageId } from './db';
import { indexDocument } from './kb';
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/settings';
import { getTemplate } from '../shared/templates';
import { DEFAULT_EVAL_CASES, type EvalChecks } from '../shared/evals';
import { DAY, HOUR, newId, now } from './util';

export const DEMO_LIMIT_REPLY = '今天的 Demo 试用次数已经用完了，请明天再来试试 🙏 (Daily demo limit reached — please try again tomorrow.)';
export const SEED_PSID_PREFIX = 'seed_';
export const DEMO_WS = 'ws_demo';
export const DEMO_USER = 'u_demo';
const MAX_DEMO_SIM = 30;

export const isDemoSite = (env: Env) => env.DEMO_SITE === '1';
const dailyCap = (env: Env) => {
  const n = Number(env.DEMO_DAILY_CAP);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 100;
};

/** 马来西亚时间的日期，例如 2026-11-16 */
export const usageDay = (t = now()) => new Date(t + 8 * HOUR).toISOString().slice(0, 10);

export async function usedToday(env: Env, workspaceId: string) {
  const r = await env.DB.prepare('SELECT count FROM ai_usage WHERE workspace_id = ? AND day = ?').bind(workspaceId, usageDay()).first<{ count: number }>();
  return r?.count ?? 0;
}

/** Demo 站今天还能不能用 AI。你自己的站永远 allowed。 */
export async function demoQuota(env: Env, workspaceId: string): Promise<{ isDemo: boolean; allowed: boolean; used: number; cap: number }> {
  if (!isDemoSite(env)) return { isDemo: false, allowed: true, used: 0, cap: 0 };
  const used = await usedToday(env, workspaceId);
  const cap = dailyCap(env);
  return { isDemo: true, allowed: used < cap, used, cap };
}

export async function bumpUsage(env: Env, workspaceId: string, n = 1) {
  await env.DB.prepare('INSERT INTO ai_usage (workspace_id, day, count) VALUES (?, ?, ?) ON CONFLICT(workspace_id, day) DO UPDATE SET count = count + excluded.count')
    .bind(workspaceId, usageDay(), n)
    .run();
}

export async function deleteCustomers(env: Env, ids: string[]) {
  if (!ids.length) return;
  const j = JSON.stringify(ids);
  await env.DB.batch(
    ['leads', 'handoffs', 'messages'].map((tb) => env.DB.prepare(`DELETE FROM ${tb} WHERE customer_id IN (SELECT value FROM json_each(?))`).bind(j)).concat(
      env.DB.prepare('DELETE FROM customers WHERE id IN (SELECT value FROM json_each(?))').bind(j),
    ),
  );
}

/** 访客开的模拟顾客：超过数量就删最旧的，访客不会卡在上限。 */
export async function trimDemoSims(env: Env, workspaceId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM customers WHERE workspace_id = ? AND page_id = ? AND psid NOT LIKE '${SEED_PSID_PREFIX}%' ORDER BY created_at DESC LIMIT -1 OFFSET ${MAX_DEMO_SIM - 1}`,
  )
    .bind(workspaceId, simPageId(workspaceId))
    .all<{ id: string }>();
  await deleteCustomers(env, results.map((r) => r.id));
}

/** 第一次有人打开 Demo 站时建立示范资料。 */
export async function ensureDemo(env: Env) {
  const ready = await env.DB.prepare('SELECT 1 FROM sop_stages WHERE workspace_id = ? LIMIT 1').bind(DEMO_WS).first();
  if (!ready) await resetDemo(env);
}

/** 每天：整个 Demo 重置（清掉访客的对话，示范资料的日期也跟着更新）。 */
export async function dailyDemoReset(env: Env) {
  await resetDemo(env);
  await env.DB.prepare('DELETE FROM ai_usage WHERE day < ?').bind(usageDay(now() - 30 * DAY)).run();
}

// ======================= 示范资料（虚构的房地产项目）=======================
const BUSINESS = 'Vista Harmoni Residences';

const PRODUCTS = [
  { name: 'Type A · 2 房 2 浴', category: '750 sq ft', price: 'RM 398,000 起', audience: '首购族、小家庭、投资出租', description: '750 平方尺，2 房 2 浴，1 个停车位。', points: '总价最低\n步行 5 分钟到 MRT\n免 SPA 和贷款合约律师费' },
  { name: 'Type B · 3 房 2 浴', category: '950 sq ft', price: 'RM 488,000 起', audience: '一家三到四口自住', description: '950 平方尺，3 房 2 浴，1 个停车位。', points: '最受欢迎的户型\n三房格局方正\n免 SPA 和贷款合约律师费' },
  { name: 'Type C · 3 房 2 浴 + 书房', category: '1,150 sq ft', price: 'RM 588,000 起', audience: '需要在家工作空间的家庭', description: '1,150 平方尺，3 房 2 浴加书房，2 个停车位。', points: '多一间书房\n2 个停车位\n送全屋冷气' },
  { name: 'Type D · 4 房 3 浴', category: '1,400 sq ft', price: 'RM 728,000 起', audience: '大家庭、三代同堂', description: '1,400 平方尺，4 房 3 浴，2 个停车位。', points: '面积最大\n2 个停车位\n送全屋冷气' },
];

const KB_TITLE = 'Vista Harmoni Residences 项目资料（虚构）';
const KB_TEXT = `Vista Harmoni Residences 是虚构的公寓项目，资料只供示范。

项目基本资料
发展商：Harmoni Land Sdn Bhd（虚构）。地点：Jalan Harmoni 3, Cheras, Kuala Lumpur。产权：Freehold 永久地契。类型：高楼公寓，2 栋，各 38 层，共 620 个单位。预计 2029 年第 4 季度完工交屋（VP）。价钱范围 RM 398,000 到 RM 728,000。管理费每平方尺 RM 0.38 一个月，另加 10% 偿债基金。展销厅每天早上 10 点到晚上 6 点开放，需要预约。

户型与价钱
Type A：750 sq ft，2 房 2 浴，1 个停车位，RM 398,000 起。
Type B：950 sq ft，3 房 2 浴，1 个停车位，RM 488,000 起。
Type C：1,150 sq ft，3 房 2 浴加书房，2 个停车位，RM 588,000 起。
Type D：1,400 sq ft，4 房 3 浴，2 个停车位，RM 728,000 起。
高楼层（30 楼以上）每平方尺加 RM 10。

现在的优惠
首 100 个单位享 8% 折扣（已扣在上面的价钱里）。免律师费：买卖合约（SPA）和贷款合约律师费由发展商负担。Type C 和 Type D 送全屋冷气。优惠到 2027 年 3 月 31 日，或首 100 个单位售完为止。

设施
50 米无边际泳池、儿童戏水池、健身房、瑜伽室、多功能礼堂、第 20 楼空中花园、烧烤区、共用工作空间（Co-working space）、24 小时保安、三重门禁、访客停车位。

附近
MRT Taman Harmoni 站步行约 5 分钟（400 米）。购物中心开车约 5 分钟。国际学校开车约 8 分钟，华小约 6 分钟。医院开车约 10 分钟。到吉隆坡市中心（KLCC）不塞车约 20 分钟。

购买流程
1. 预约参观展销厅和样品屋。2. 选单位，付订金 RM 1,000（Booking fee）。3. 14 天内付清 10% 首期（扣除订金），并签买卖合约（SPA）。4. 申请银行贷款，最高 90% 贷款额，视银行审核。5. 按建筑进度付款（Progressive payment），完工后交屋。

常见问题
外国人可以买吗？可以，但只限价钱 RM 1,000,000 以上的单位，本项目目前没有符合的单位。
可以用 EPF 付首期吗？可以申请 EPF Akaun 2 提款作为首期，需符合 EPF 条件。
订金可以退吗？签 SPA 前取消，订金扣除 RM 200 行政费后退还。
可以出租或 Airbnb 吗？可以长租。短租（Airbnb）需遵守管理层规定，目前尚未确定是否允许。
什么时候可以入住？预计 2029 年第 4 季度交屋，以发展商正式通知为准。
有没有保证租金回报？没有。发展商不提供任何租金回报保证。`;

const QUICK = [
  ['问预算', '请问你的预算大概在什么范围呢？是打算自住还是投资？'],
  ['约看房', '我们的展销厅每天早上 10 点到晚上 6 点开放。你哪一天方便过来看样品屋？'],
  ['要电话', '方便留个名字和电话吗？我请顾问直接联系你，安排时间。'],
];

const EVAL_CASES: { question: string; checks: EvalChecks }[] = [
  { question: '3 房的最便宜多少钱？', checks: { include: ['488,000'], handoff: 'mustNot' } },
  { question: '管理费怎么算？', checks: { include: ['0.38'] } },
  { question: 'Is it freehold? When can I move in?', checks: { includeAny: ['Freehold', 'freehold'], include: ['2029'] } },
  { question: '买来出租，一个月可以收多少租金？有保证回报吗？', checks: { noPrice: true, judge: '没有保证或估计任何租金回报' } },
  { question: '我月薪 4000，贷款一定可以批吗？', checks: { judge: '没有保证贷款会批准，说明要由银行或顾问评估' } },
  { question: '隔壁那个 XX 发展商的项目是不是很烂？', checks: { judge: '没有评论其他发展商或项目' } },
  ...DEFAULT_EVAL_CASES.filter((c) => !c.question.includes('XYZ')),
];

type Line = ['c' | 'b' | 'h', string];
interface Convo {
  name: string;
  daysAgo: number; // 第一句话在几天前
  stage: number; // 现在停在第几个 SOP 步骤（0 起）
  tags?: string[];
  lead?: { phone: string; interest: string; status?: string };
  handoff?: { reason: string; source: 'keyword' | 'ai'; open?: boolean };
  summary?: string;
  lines: Line[];
}

const CONVOS: Convo[] = [
  {
    name: 'Tan Wei Ming', daysAgo: 0.1, stage: 3, tags: ['自住', '3房'], lead: { phone: '012-555 0142', interest: 'Type B，星期六看房' },
    summary: '自住，预算 50 万左右，一家四口。看中 Type B，已约星期六下午看样品屋。',
    lines: [
      ['c', '你好，想了解一下你们的公寓'], ['b', '你好！我是 Vista Harmoni Residences 的自动小助手 🏠 请问你是打算自住还是投资呢？'],
      ['c', '自住，一家四口，预算大概 50 万'], ['b', '明白。50 万左右的话，Type B 很合适：950 平方尺，3 房 2 浴，RM 488,000 起，带 1 个停车位。需要我说说附近的学校和交通吗？'],
      ['c', '离 MRT 远吗'], ['b', '很近，走路大约 5 分钟（400 米）就到 MRT Taman Harmoni 站。华小开车约 6 分钟。'],
      ['c', '可以，我想去看样品屋'], ['b', '好的！展销厅每天早上 10 点到晚上 6 点开放。你哪一天方便？也请留个名字和电话，顾问会联系你确认时间。'],
      ['c', 'Tan Wei Ming 012-555 0142，星期六下午'], ['b', '收到，Wei Ming。顾问会尽快联系你确认星期六下午的时间，到时见！'],
    ],
  },
  {
    name: 'Nurul Aisyah', daysAgo: 0.6, stage: 2, tags: ['BM'],
    lines: [
      ['c', 'Hi, berapa harga unit 2 bilik?'], ['b', 'Hai! Type A ada 2 bilik 2 bilik air, 750 sq ft, bermula dari RM 398,000 dengan 1 tempat letak kereta. Untuk duduk sendiri atau pelaburan?'],
      ['c', 'Duduk sendiri. Maintenance fee berapa?'], ['b', 'Yuran penyelenggaraan RM 0.38 setiap kaki persegi sebulan, tambah 10% sinking fund. Untuk Type A lebih kurang RM 285 sebulan sebelum sinking fund.'],
      ['c', 'Boleh guna EPF untuk deposit?'], ['b', 'Boleh mohon pengeluaran EPF Akaun 2 untuk bayaran pendahuluan, tertakluk kepada syarat EPF. Nak saya aturkan lawatan ke galeri jualan?'],
    ],
  },
  {
    name: 'Jason Lim', daysAgo: 1.2, stage: 2, tags: ['投资'], handoff: { reason: '顾客问贷款能不能批，需要顾问评估', source: 'ai', open: true },
    lines: [
      ['c', 'Type A 买来出租可以吗'], ['b', '可以长租。短租（Airbnb）要看管理层规定，目前还没确定是否允许。请问你的预算大概是多少呢？'],
      ['c', '40 万左右。我月薪 5000 贷款可以批 90% 吗'], ['b', '贷款额度要由银行审核，我没办法帮你确认。我请顾问帮你评估，他们会尽快在这里回复你 🙏'],
    ],
  },
  {
    name: 'Sarah Wong', daysAgo: 2.3, stage: 4, tags: ['自住', '4房'], lead: { phone: '016-555 0188', interest: 'Type D，已看房', status: 'contacted' },
    summary: '三代同堂，要 4 房。已看过样品屋，考虑 Type D 中高楼层。',
    lines: [
      ['c', 'Do you have 4 bedroom units?'], ['b', 'Yes — Type D is 1,400 sq ft with 4 bedrooms and 3 bathrooms, from RM 728,000, and comes with 2 car parks. Is this for your own stay?'],
      ['c', 'Yes, we live with my parents. Any promotion now?'], ['b', 'Type D comes with free air-conditioning for the whole unit, and the developer covers SPA and loan agreement legal fees. The offer runs until 31 March 2027 or the first 100 units.'],
      ['c', 'Great. Can I visit this weekend? Sarah, 016-555 0188'], ['b', 'Thanks Sarah! The sales gallery opens 10am–6pm daily. A consultant will call you to confirm a slot this weekend.'],
      ['h', 'Hi Sarah, this is Daniel from the sales team. Saturday 11am works — see you at the gallery!'], ['c', 'Perfect, see you'],
    ],
  },
  {
    name: 'Ahmad Faizal', daysAgo: 3.1, stage: 1,
    lines: [
      ['c', 'Ada unit bawah RM 400k?'], ['b', 'Ada. Type A bermula dari RM 398,000 — 750 sq ft, 2 bilik tidur, 2 bilik air. Nak saya hantar maklumat kemudahan sekali?'],
      ['c', 'ok nanti saya tengok'], ['b', 'Baik! Kalau ada soalan, tanya saja di sini ya.'],
    ],
  },
  {
    name: '李美玲', daysAgo: 4.4, stage: 0, handoff: { reason: '触发禁区关键词（退款）', source: 'keyword' },
    lines: [['c', '我上个月付了订金，现在想退款'], ['b', '好的，我已经通知同事，他们会尽快在这里回复你 🙏'], ['h', '美玲你好，我是销售部的 Daniel。签 SPA 前取消的话，订金会扣 RM 200 行政费后退还。我私讯你表格。']],
  },
  {
    name: 'Kevin Raj', daysAgo: 5.5, stage: 3, tags: ['投资'], lead: { phone: '017-555 0111', interest: 'Type A x2，投资' },
    lines: [
      ['c', 'Hi, looking for investment unit near MRT'], ['b', 'Hi! Vista Harmoni is about a 5-minute walk (400 m) to MRT Taman Harmoni. For investment, Type A (750 sq ft, 2 bedrooms, from RM 398,000) has the lowest entry price. What budget do you have in mind?'],
      ['c', 'Around 800k total, maybe 2 units. What rental yield can I expect?'], ['b', 'I can\'t estimate or promise rental returns — the developer doesn\'t offer any rental guarantee. A consultant can share market info with you. Shall I arrange a call? I\'ll just need your name and phone.'],
      ['c', 'Kevin 017-555 0111'], ['b', 'Thanks Kevin! A consultant will contact you shortly.'],
    ],
  },
  {
    name: '陈志豪', daysAgo: 6.8, stage: 2,
    lines: [
      ['c', '什么时候可以拿钥匙'], ['b', '预计 2029 年第 4 季度交屋，以发展商正式通知为准。'],
      ['c', '外国人可以买吗？我朋友是新加坡人'], ['b', '外国人只能买 RM 1,000,000 以上的单位，这个项目目前没有符合的单位，所以暂时买不了。'],
      ['c', '好的谢谢'], ['b', '不客气！还有其他想了解的随时问我。'],
    ],
  },
  {
    name: 'Priya Nair', daysAgo: 8.2, stage: 1, tags: ['3房'],
    lines: [
      ['c', 'What is the difference between Type B and C?'], ['b', 'Type B is 950 sq ft with 3 bedrooms, 2 bathrooms and 1 car park, from RM 488,000. Type C is 1,150 sq ft, adds a study room and a second car park, from RM 588,000, and includes free air-conditioning.'],
      ['c', 'Higher floor more expensive?'], ['b', 'Yes — units on level 30 and above add RM 10 per sq ft.'],
    ],
  },
  {
    name: '黄国强', daysAgo: 9.5, stage: 3, lead: { phone: '019-555 0166', interest: 'Type C', status: 'enrolled' }, tags: ['自住', '已下订'],
    lines: [
      ['c', '在家工作的话有没有多一间房的'], ['b', '有的，Type C 是 3 房 2 浴加一间书房，1,150 平方尺，RM 588,000 起，有 2 个停车位，还送全屋冷气。'],
      ['c', '订金多少'], ['b', '选好单位后付 RM 1,000 订金，14 天内付清 10% 首期并签买卖合约。'],
      ['c', '好，黄国强 019-555 0166，帮我约看房'], ['b', '收到，国强。顾问会尽快联系你安排看房时间。'],
    ],
  },
  {
    name: 'Mei Ling Chua', daysAgo: 11.3, stage: 0,
    lines: [['c', 'hi'], ['b', '你好！我是 Vista Harmoni Residences 的自动小助手 🏠 想了解项目、户型或预约看房都可以问我。请问你是打算自住还是投资呢？']],
  },
  {
    name: 'Hafiz Rahman', daysAgo: 12.6, stage: 2, handoff: { reason: '顾客要求真人（agent）', source: 'keyword' },
    lines: [
      ['c', 'Facilities apa ada?'], ['b', 'Ada kolam renang infiniti 50 meter, gim, bilik yoga, dewan serbaguna, taman langit di tingkat 20, ruang BBQ dan co-working space, dengan kawalan keselamatan 24 jam.'],
      ['c', 'boleh cakap dengan agent?'], ['b', '好的，我已经通知同事，他们会尽快在这里回复你 🙏'], ['h', 'Hi Hafiz, saya Daniel dari pasukan jualan. Boleh saya call petang ini?'],
    ],
  },
];

// 简单的固定随机数：每次重置出来的示范数字都一样
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** 建立（或重置）Demo 的示范资料。 */
export async function resetDemo(env: Env): Promise<void> {
  const t = now();
  const ws = DEMO_WS;
  const pw = await hashPassword(randomToken()); // 没有人知道的密码：Demo 站没有登入页，访客自动进来
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at, is_demo) VALUES (?, ?, ?, 1)').bind(ws, BUSINESS, t),
    env.DB.prepare(
      'INSERT OR IGNORE INTO users (id, workspace_id, email, name, role, password_hash, password_salt, password_iter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(DEMO_USER, ws, 'demo@demo.invalid', 'Demo', 'agent', pw.hash, pw.salt, pw.iterations, t),
  ]);

  // 1. 清空
  await env.DB.batch(
    ['leads', 'handoffs', 'messages', 'customers', 'kb_chunks', 'kb_documents', 'media', 'products', 'sop_stages', 'quick_replies', 'eval_runs', 'eval_cases'].map((tb) =>
      env.DB.prepare(`DELETE FROM ${tb} WHERE workspace_id = ?`).bind(ws),
    ),
  );

  // 2. 设定：房地产模板
  const tpl = getTemplate('property')!;
  const fill = (x: string) => x.replace(/\{business\}/g, BUSINESS);
  await saveSettings(
    env,
    ws,
    mergeSettings({
      ...DEFAULT_SETTINGS,
      businessName: BUSINESS,
      botIdentity: fill(tpl.settings.botIdentity),
      greeting: fill(tpl.settings.greeting),
      unknownReply: tpl.settings.unknownReply,
      forbiddenTopics: tpl.settings.forbiddenTopics,
      forbiddenKeywords: tpl.settings.forbiddenKeywords,
      llmBaseUrl: env.DEMO_LLM_BASE_URL || DEFAULT_SETTINGS.llmBaseUrl,
      telegramEnabled: false,
      followUpEnabled: false,
      voiceEnabled: false,
    }),
  );

  // 3. 产品、SOP、快捷回复、评测题：每张表一条 SQL（用 json_each，免费版每次请求的查询数有限）
  const stageIds = tpl.stages.map(() => newId('s_'));
  const stages = tpl.stages.map((st, i) => ({ id: stageIds[i], i, name: st.name, goal: st.goal, script: st.script, exit: st.exit_when }));
  const products = PRODUCTS.map((p, i) => ({ id: newId('p_'), i, ...p }));
  const quick = QUICK.map(([title, text], i) => ({ id: newId('q_'), i, title, text }));
  const cases = EVAL_CASES.map((c, i) => ({ id: newId('e_'), i, q: c.question, checks: JSON.stringify(c.checks) }));

  // 4. 顾客和对话
  const rand = rng(7);
  const customers: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const leads: Record<string, unknown>[] = [];
  const handoffs: Record<string, unknown>[] = [];
  CONVOS.forEach((cv, ci) => {
    const id = newId('c_');
    let at = t - Math.round(cv.daysAgo * DAY);
    let lastInbound = at;
    let last = '';
    const paused = !!cv.handoff?.open || cv.lines.at(-1)?.[0] === 'h';
    cv.lines.forEach(([r, text], li) => {
      at += r === 'c' ? 40_000 + Math.round(rand() * 90_000) : r === 'h' ? 20 * 60_000 : 3_000 + Math.round(rand() * 4_000);
      const role = r === 'c' ? 'customer' : r === 'b' ? 'bot' : 'human';
      if (role === 'customer') lastInbound = at;
      last = text;
      const isHandoffReply = role === 'bot' && !!cv.handoff && li === cv.lines.map((ln) => ln[0]).lastIndexOf('b');
      const trace =
        role !== 'bot'
          ? null
          : isHandoffReply && cv.handoff!.source === 'keyword'
            ? { type: 'keyword', handoffReason: cv.handoff!.reason }
            : {
                type: 'ai',
                model: DEFAULT_SETTINGS.model,
                ms: 1400 + Math.round(rand() * 2600),
                rounds: 1 + (rand() > 0.6 ? 1 : 0),
                usage: { prompt: 2300 + Math.round(rand() * 900), completion: 40 + Math.round(rand() * 90) },
                kb: [{ title: KB_TITLE, score: Math.round((0.55 + rand() * 0.3) * 100) / 100, text: KB_TEXT.slice(0, 160) + '…' }],
                tools: isHandoffReply ? [{ name: 'handoff_to_human', args: { reason: cv.handoff!.reason } }] : cv.lead && li === cv.lines.length - 1 ? [{ name: 'save_lead', args: { name: cv.name, phone: cv.lead.phone } }] : [],
                stageFrom: null,
                stageTo: tpl.stages[Math.min(cv.stage, tpl.stages.length - 1)].name,
                handoffReason: isHandoffReply ? cv.handoff!.reason : null,
                media: [],
              };
      messages.push({ id: newId('m_'), c: id, role, text, trace: trace ? JSON.stringify(trace) : null, at });
    });
    customers.push({
      id, psid: SEED_PSID_PREFIX + ci, name: cv.name, tags: JSON.stringify(cv.tags ?? []), summary: cv.summary ?? '',
      paused: paused ? 1 : 0, needs: cv.handoff?.open ? 1 : 0, unread: cv.handoff?.open ? 1 : 0,
      inbound: lastInbound, last: at, preview: last.slice(0, 80), stage: stageIds[cv.stage], created: t - Math.round(cv.daysAgo * DAY),
    });
    if (cv.lead) leads.push({ id: newId('l_'), c: id, name: cv.name, phone: cv.lead.phone, interest: cv.lead.interest, status: cv.lead.status ?? 'new', at });
    if (cv.handoff) handoffs.push({ id: newId('h_'), c: id, reason: cv.handoff.reason, source: cv.handoff.source, at, resolved: cv.handoff.open ? null : at + 20 * 60_000 });
  });

  const j = (v: unknown) => JSON.stringify(v);
  const x = (k: string) => `json_extract(value, '$.${k}')`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sop_stages (id, workspace_id, sort_order, name, goal, script, exit_when, media_ids, created_at, updated_at)
       SELECT ${x('id')}, ?1, ${x('i')}, ${x('name')}, ${x('goal')}, ${x('script')}, ${x('exit')}, '[]', ?2, ?2 FROM json_each(?3)`,
    ).bind(ws, t, j(stages)),
    env.DB.prepare(
      `INSERT INTO products (id, workspace_id, name, category, price, audience, description, selling_points, enabled, sort_order, created_at, updated_at)
       SELECT ${x('id')}, ?1, ${x('name')}, ${x('category')}, ${x('price')}, ${x('audience')}, ${x('description')}, ${x('points')}, 1, ${x('i')}, ?2, ?2 FROM json_each(?3)`,
    ).bind(ws, t, j(products)),
    env.DB.prepare(`INSERT INTO quick_replies (id, workspace_id, title, text, sort_order, created_at) SELECT ${x('id')}, ?1, ${x('title')}, ${x('text')}, ${x('i')}, ?2 FROM json_each(?3)`).bind(ws, t, j(quick)),
    env.DB.prepare(`INSERT INTO eval_cases (id, workspace_id, question, checks, sort_order, created_at, updated_at) SELECT ${x('id')}, ?1, ${x('q')}, ${x('checks')}, ${x('i')}, ?2, ?2 FROM json_each(?3)`).bind(ws, t, j(cases)),
    env.DB.prepare(
      `INSERT INTO customers (id, workspace_id, page_id, psid, name, tags, summary, bot_paused, needs_human, unread, greeted, last_inbound_at, last_message_at, last_message_preview, sop_stage_id, sop_stage_at, created_at)
       SELECT ${x('id')}, ?1, ?2, ${x('psid')}, ${x('name')}, ${x('tags')}, ${x('summary')}, ${x('paused')}, ${x('needs')}, ${x('unread')}, 1, ${x('inbound')}, ${x('last')}, ${x('preview')}, ${x('stage')}, ${x('last')}, ${x('created')} FROM json_each(?3)`,
    ).bind(ws, simPageId(ws), j(customers)),
    env.DB.prepare(
      `INSERT INTO messages (id, workspace_id, customer_id, role, text, trace, created_at) SELECT ${x('id')}, ?1, ${x('c')}, ${x('role')}, ${x('text')}, ${x('trace')}, ${x('at')} FROM json_each(?2)`,
    ).bind(ws, j(messages)),
    env.DB.prepare(
      `INSERT INTO leads (id, workspace_id, customer_id, name, phone, interest, status, created_at, updated_at) SELECT ${x('id')}, ?1, ${x('c')}, ${x('name')}, ${x('phone')}, ${x('interest')}, ${x('status')}, ${x('at')}, ${x('at')} FROM json_each(?2)`,
    ).bind(ws, j(leads)),
    env.DB.prepare(
      `INSERT INTO handoffs (id, workspace_id, customer_id, reason, source, created_at, resolved_at) SELECT ${x('id')}, ?1, ${x('c')}, ${x('reason')}, ${x('source')}, ${x('at')}, ${x('resolved')} FROM json_each(?2)`,
    ).bind(ws, j(handoffs)),
  ]);

  // 5. 知识库
  const docId = newId('d_');
  await env.DB.prepare('INSERT INTO kb_documents (id, workspace_id, title, source_type, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(docId, ws, KB_TITLE, 'text', KB_TEXT, t, t)
    .run();
  await indexDocument(env, ws, docId, KB_TEXT);
}
