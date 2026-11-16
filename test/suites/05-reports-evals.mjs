// 数据报表 + AI 评测（你自己的站）
import { execSync } from 'node:child_process';
import { client, check, done, mockClear } from './_lib.mjs';
const own = client('http://localhost:8787');
const sql = (q) => JSON.parse(execSync(`npx wrangler d1 execute DB --local --json --persist-to ${process.env.TEST_PERSIST} -c ${process.env.TEST_CONFIG} --command "${q}"`, { stdio: 'pipe' }).toString())[0].results[0];

await own('POST', '/api/auth/setup', { setupKey: 'setup123', workspaceName: '测试店', name: 'Peko', email: 'peko@test.com', password: 'password123' });
await own('PUT', '/api/system/deepseek', { apiKey: 'sk-test' });
const s = (await own('GET', '/api/settings')).j.settings;
s.llmBaseUrl = 'http://localhost:9999'; s.rateLimitPerMinute = 30; s.greetingEnabled = false;
await own('PUT', '/api/settings', s);

// ---------- reports ----------
let r = await own('GET', '/api/reports?days=7&tz=480');
check('empty report ok', r.status === 200 && r.j.totals.active === 0 && r.j.daily.length === 7 && r.j.funnel.length === 5, JSON.stringify(r.j).slice(0, 300));
const mk = async () => (await own('POST', '/api/sim/customers', {})).j.id;
const say = (id, text) => own('POST', `/api/sim/customers/${id}/messages`, { text });
const a = await mk(), b = await mk(), c3 = await mk();
await say(a, '你好'); await say(a, '多少钱');
await say(b, '我要报名');
await say(c3, '有付款问题');
r = await own('GET', '/api/reports?days=7&tz=480');
const T = r.j.totals;
check('report totals', T.active === 3 && T.inbound === 4 && T.leads === 1 && T.handoffs === 1 && T.withHuman === 1 && T.botOnly === 2 && T.aiReplies >= 3 && T.tokens > 0, JSON.stringify(T));
check('report daily: today in last bucket', r.j.daily.at(-1).customer === 4 && r.j.daily.slice(0, -1).every((d) => d.customer === 0), JSON.stringify(r.j.daily.at(-1)));
check('funnel reached is cumulative', r.j.funnel[0].reached === 3 && r.j.funnel[2].reached === 1 && r.j.funnel[2].here === 1 && r.j.funnel[0].here === 2, JSON.stringify(r.j.funnel));
check('handoff sources', r.j.handoffSources.ai === 1, JSON.stringify(r.j.handoffSources));
r = await own('GET', '/api/reports?days=30&tz=480&sim=0');
check('exclude simulator → empty', r.j.totals.active === 0 && r.j.totals.leads === 0 && r.j.daily.length === 30, JSON.stringify(r.j.totals));

// ---------- evals ----------
r = await own('GET', '/api/eval'); check('eval empty', r.j.cases.length === 0 && r.j.runs.length === 0);
await own('POST', '/api/eval/cases', { defaults: true });
r = await own('GET', '/api/eval'); check('starter cases loaded', r.j.cases.length === 8, r.j.cases.length);
r = await own('POST', '/api/eval/cases', { question: 'x', checks: {} }); check('case needs a check', r.status === 400);
const add = async (question, checks) => (await own('POST', '/api/eval/cases', { question, checks })).j.id;
const k1 = await add('多少钱', { include: ['RM 99'], handoff: 'mustNot' });
const k2 = await add('多少钱', { noPrice: true });
const k3 = await add('有付款问题', { handoff: 'must' });
const k4 = await add('我要报名', { saveLead: true, exclude: ['RM'] });
const k5 = await add('随便问问', { judge: 'PASSME 礼貌' });
const k6 = await add('随便问问', { judge: '应该失败', includeAny: ['不存在', '测试回复'] });
const k7 = await add('我要找真人', { handoff: 'must' });
const runId = (await own('POST', '/api/eval/runs')).j.id;
const res = {};
await mockClear();
for (const k of [k1, k2, k3, k4, k5, k6, k7]) res[k] = (await own('POST', `/api/eval/runs/${runId}/cases/${k}`)).j.result;
check('include + no handoff → pass', res[k1].pass === true && res[k1].checks.length === 2, JSON.stringify(res[k1]));
check('noPrice fails on "RM 99"', res[k2].pass === false && res[k2].checks[0].label === 'noPrice', JSON.stringify(res[k2]));
check('handoff via AI tool', res[k3].pass === true && res[k3].tools.includes('handoff_to_human'), JSON.stringify(res[k3]));
check('saveLead', res[k4].pass === true, JSON.stringify(res[k4]));
check('LLM judge pass', res[k5].pass === true && res[k5].checks[0].detail === 'mock judge', JSON.stringify(res[k5]));
check('judge fail → case fails', res[k6].pass === false && res[k6].checks.find((x) => x.label.startsWith('includeAny')).pass === true, JSON.stringify(res[k6]));
check('keyword handoff without LLM', res[k7].pass === true && res[k7].handoffReason.includes('真人'), JSON.stringify(res[k7]));
check('evals have no side effects', sql('SELECT (SELECT COUNT(*) FROM leads) AS l').l === 1);
r = await own('GET', '/api/eval');
check('run saved with score', r.j.runs[0].total === 7 && r.j.runs[0].passed === 5 && r.j.runs[0].results.length === 7, JSON.stringify({ t: r.j.runs[0].total, p: r.j.runs[0].passed }));
await own('PATCH', `/api/eval/cases/${k2}`, { question: '多少钱?', checks: { include: ['RM 99'] } });
await own('DELETE', `/api/eval/cases/${k6}`);
r = await own('GET', '/api/eval');
check('edit + delete case', r.j.cases.length === 14 && r.j.cases.find((x) => x.id === k2).checks.include[0] === 'RM 99' && !r.j.cases.find((x) => x.id === k2).checks.noPrice);
done();
