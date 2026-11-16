// 公开 Demo 站（wrangler.demo.jsonc，:8788）：独立数据库、没有登入、只读、每日 AI 上限
import { client, check, done, mockClear, mockLog } from './_lib.mjs';
const B = 'http://localhost:8788';
const v = client(B);

let r = await v('GET', '/api/auth/status');
check('status: demo site, not logged in', r.j.demoSite === true && r.j.user === null && r.j.needsSetup === false && r.j.repoUrl?.includes('github.com'), JSON.stringify(r.j));
r = await v('POST', '/api/auth/setup', { setupKey: 'setup123', email: 'a@b.co', password: '12345678' }); check('setup disabled', r.status === 404);
r = await v('POST', '/api/auth/login', { email: 'demo@demo.invalid', password: 'x' }); check('login disabled', r.status === 404);
r = await fetch(B + '/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1'); check('webhook disabled', r.status === 404);
r = await fetch(B + '/media/abc.jpg'); check('media disabled', r.status === 404);
r = await v('GET', '/api/conversations'); check('API needs the demo session', r.status === 401);

r = await v('POST', '/api/auth/demo'); check('enter demo (seeds on first visit)', r.status === 200, JSON.stringify(r.j));
r = await v('GET', '/api/auth/status'); check('visitor is a read-only demo agent', r.j.user?.demo === true && r.j.user.role === 'agent');
r = await v('GET', '/api/conversations'); check('12 seeded conversations', r.j.conversations.length === 12 && r.j.counts.human >= 1, r.j.conversations?.length);
const seedId = r.j.conversations[0].id;
r = await v('GET', `/api/conversations/${seedId}`); check('seeded messages have traces and a lead', r.j.messages.length === 10 && r.j.messages[1].trace?.type === 'ai' && r.j.lead?.phone === '012-555 0142');
r = await v('GET', '/api/reports?days=14&tz=480'); check('reports populated', r.j.totals.active === 12 && r.j.totals.leads === 4 && r.j.totals.handoffs === 3 && r.j.daily.filter((d) => d.customer > 0).length >= 8, JSON.stringify(r.j.totals));
r = await v('GET', '/api/products'); check('4 products', r.j.products.length === 4 && r.j.products[1].price.includes('488,000'));
r = await v('GET', '/api/kb'); check('knowledge base indexed', r.j.documents.length === 1 && r.j.documents[0].chunk_count > 0);
r = await v('GET', '/api/eval'); check('13 eval cases', r.j.cases.length === 13);
r = await v('GET', '/api/system'); check('no secrets configured', r.j.hasDeepseekKey === false && r.j.page === null && r.j.hasTelegramToken === false, JSON.stringify(r.j));

// read-only
const denied = [
  ['PUT', '/api/settings', {}], ['POST', '/api/products', { name: 'x' }], ['POST', '/api/kb', { title: 'x', content: 'y' }], ['PATCH', `/api/customers/${seedId}`, { name: 'hack' }],
  ['POST', `/api/conversations/${seedId}/messages`, { text: 'hi' }], ['POST', `/api/conversations/${seedId}/pause`, { paused: false }], ['DELETE', '/api/leads/x', {}], ['PUT', '/api/system/deepseek', { apiKey: 'evil' }],
  ['PUT', '/api/system/page', { pageToken: 'x' }], ['POST', '/api/users/me/password', { current: 'a', next: 'bbbbbbbbb' }], ['POST', '/api/users', { email: 'a@b.co', password: '12345678' }],
  ['POST', '/api/quick-replies', { text: 'x' }], ['POST', '/api/followups/run', {}], ['POST', '/api/eval/cases', { defaults: true }], ['PUT', '/api/sop', { stages: [] }],
  ['POST', '/api/templates/course/apply', {}], ['POST', `/api/sim/customers/${seedId}/messages`, { text: 'x' }], ['DELETE', `/api/sim/customers/${seedId}`, {}], ['PUT', '/api/sim/customers/x/audio', {}], ['PUT', '/api/media', {}],
];
const bad = [];
for (const [m, p, bd] of denied) { const x = await v(m, p, bd); if (![403, 404].includes(x.status)) bad.push(`${m} ${p} → ${x.status}`); }
check('all writes denied', bad.length === 0, bad.join('; '));

// chat in the simulator with the demo key
const mk = async () => (await v('POST', '/api/sim/customers', {})).j.id;
const say = (id, text) => v('POST', `/api/sim/customers/${id}/messages`, { text });
const d1 = await mk(); check('visitor can create a simulated customer', !!d1);
await mockClear();
await say(d1, '多少钱');
r = await v('GET', `/api/conversations/${d1}`);
check('bot replies', r.j.messages.at(-1)?.role === 'bot' && r.j.messages.at(-1).text.includes('RM 99'), r.j.messages?.map((m) => m.role + ':' + m.text).join('|'));
const llm = (await mockLog()).filter((x) => x.path === '/chat/completions');
check('prompt contains demo project', llm[0].body.messages[0].content.includes('Vista Harmoni') && llm[0].body.messages[0].content.includes('RM 488,000'));
r = await v('POST', '/api/test-chat', { messages: [{ role: 'customer', text: '你好' }], settings: { llmBaseUrl: 'http://evil.example' } });
check('test-chat ignores visitor settings', r.status === 200 && r.j.reply.includes('测试回复'), JSON.stringify(r.j).slice(0, 200));

// daily cap = 5 (set by test runner). Used: 1 sim + 1 test-chat = 2
const dr = (await v('POST', '/api/eval/runs')).j.id;
const dc = (await v('GET', '/api/eval')).j.cases;
for (let i = 0; i < 3; i++) r = await v('POST', `/api/eval/runs/${dr}/cases/${dc[i].id}`);
check('eval runs until the cap', r.status === 200, r.status);
r = await v('POST', `/api/eval/runs/${dr}/cases/${dc[3].id}`); check('eval blocked at cap', r.status === 429);
r = await v('POST', '/api/test-chat', { messages: [{ role: 'customer', text: '你好' }] }); check('test-chat blocked at cap', r.status === 429);
await mockClear();
await say(d1, '还在吗');
r = await v('GET', `/api/conversations/${d1}`);
check('simulator at cap → fixed reply, no LLM call', r.j.messages.at(-1).trace?.type === 'demo_limit' && (await mockLog()).filter((x) => x.path === '/chat/completions').length === 0);

r = await v('DELETE', `/api/sim/customers/${seedId}`); check('cannot delete seeded conversation', r.status === 404);
const tmp = await mk(); r = await v('DELETE', `/api/sim/customers/${tmp}`); check('can delete own simulated customer', r.status === 200);

// visitor simulated customers are capped at 30
for (let i = 0; i < 31; i++) await mk();
r = await v('GET', '/api/sim/customers'); check('visitor sims trimmed to 30', r.j.customers.length === 30 && !r.j.customers.some((x) => x.id === d1), r.j.customers.length);
r = await v('GET', '/api/conversations'); check('seeded conversations survive', r.j.conversations.filter((x) => x.psid.startsWith('seed_')).length === 12);

// daily cron: full reset
r = await fetch(B + '/__scheduled?cron=0+19+*+*+*'); await new Promise((x) => setTimeout(x, 1500));
r = await v('GET', '/api/conversations'); check('daily reset: back to 12 seeded, session kept', r.status === 200 && r.j.conversations.length === 12, `${r.status} ${r.j.conversations?.length}`);

// too many demo sessions from one IP (limit 20/hour; 1 used above)
let last;
for (let i = 0; i < 20; i++) last = await client(B)('POST', '/api/auth/demo');
check('demo entry rate-limited per IP', last.status === 429, last.status);
done();
