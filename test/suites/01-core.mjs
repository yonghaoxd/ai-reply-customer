import crypto from 'node:crypto';
const B = 'http://localhost:8787';
let cookie = '';
const results = [];
const check = (name, cond, extra='') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };
async function call(method, path, body, headers = {}) {
  const r = await fetch(B + path, { method, headers: { 'X-Requested-With': 'mcs', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { status: r.status, j };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function webhook(payload, secret = 'testsecret') {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const r = await fetch(B + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
  return r.status;
}
const msg = (psid, mid, text) => ({ object: 'page', entry: [{ id: 'PAGE1', time: Date.now(), messaging: [{ sender: { id: psid }, recipient: { id: 'PAGE1' }, timestamp: Date.now(), message: { mid, text } }] }] });
const echo = (psid, mid, text, app_id) => ({ object: 'page', entry: [{ id: 'PAGE1', time: Date.now(), messaging: [{ sender: { id: 'PAGE1' }, recipient: { id: psid }, timestamp: Date.now(), message: { mid, text, is_echo: true, app_id } }] }] });
const mockLog = async () => (await fetch('http://localhost:9999/__log')).json();
const sentTexts = async () => (await mockLog()).filter(x => x.path.endsWith('/me/messages') && x.body?.message).map(x => x.body.message.text);

// --- webhook verify
let r = await fetch(B + '/webhook?hub.mode=subscribe&hub.verify_token=verify123&hub.challenge=abc'); check('webhook verify', (await r.text()) === 'abc');
r = await fetch(B + '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc'); check('webhook verify wrong token 403', r.status === 403);
// --- auth
check('csrf header required', (await fetch(B + '/api/auth/login', { method: 'POST', body: '{}', headers: {'Content-Type':'application/json'} })).status === 400);
check('setup bad key', (await call('POST', '/api/auth/setup', { setupKey: 'x', email: 'a@b.com', password: '12345678' })).status === 403);
check('setup ok', (await call('POST', '/api/auth/setup', { setupKey: 'setup123', workspaceName: 'Ai教育掌握未来', name: 'Peko', email: 'peko@test.com', password: 'password123' })).status === 200);
check('setup twice blocked', (await call('POST', '/api/auth/setup', { setupKey: 'setup123', email: 'x@b.com', password: '12345678' })).status === 400);
const savedCookie = cookie; cookie='';
check('api needs login', (await call('GET', '/api/settings')).status === 401);
check('login wrong pw', (await call('POST', '/api/auth/login', { email: 'peko@test.com', password: 'nope' })).status === 401);
check('login ok', (await call('POST', '/api/auth/login', { email: 'peko@test.com', password: 'password123' })).status === 200);
r = await call('GET', '/api/products'); check('3 seeded products', r.j.products?.length === 3);
// --- system setup
check('connect page', (await call('PUT', '/api/system/page', { pageToken: 'EAAtest' })).status === 200);
check('deepseek key', (await call('PUT', '/api/system/deepseek', { apiKey: 'sk-test' })).status === 200);
let s = (await call('GET', '/api/settings')).j.settings;
s.llmBaseUrl = 'http://localhost:9999'; s.autoResumeHours = 12;
check('save settings', (await call('PUT', '/api/settings', s)).status === 200);
// --- KB
r = await call('POST', '/api/kb', { title: '上课时间', content: '我们的直播课每个星期六晚上 8 点开始，每堂课 2 小时。\n\n课程有回放，可以看一年。' });
check('kb add', r.status === 200, JSON.stringify(r.j));
// --- test chat
r = await call('POST', '/api/test-chat', { messages: [{ role: 'customer', text: '上课时间是几点？' }] });
check('test chat KB hit', r.j.reply?.includes('[KB命中]') && r.j.reply?.includes('[有产品]') && !r.j.reply.includes('**'), JSON.stringify(r.j.reply));
r = await call('POST', '/api/test-chat', { messages: [{ role: 'customer', text: '我要找真人' }] });
check('test chat handoff keyword', !!r.j.handoffReason, r.j.handoffReason);

// --- webhook: bad signature
check('bad signature 401', (await webhook(msg('111', 'mid.1', 'hi'), 'wrong')) === 401);
await fetch('http://localhost:9999/__clear');
// first message → greeting + AI reply
check('webhook 200', (await webhook(msg('111', 'mid.c1', '上课时间几点？'))) === 200);
await sleep(2500);
let texts = await sentTexts();
check('greeting sent', texts[0]?.includes('自动小助手'), JSON.stringify(texts));
check('ai reply sent', texts[1]?.includes('[KB命中]'), texts[1]);
// duplicate webhook → no extra reply
await webhook(msg('111', 'mid.c1', '上课时间几点？')); await sleep(1500);
check('duplicate ignored', (await sentTexts()).length === 2);
// echo of our own bot message (app_id 999) → ignored
await webhook(echo('111', 'mid.bot.1', '你好！我是…', 999)); await sleep(1200);
let conv = (await call('GET', '/api/conversations')).j.conversations;
const cid = conv[0].id;
check('conversation listed w/ profile name', conv[0].name === 'Ali Test' && conv[0].unread >= 1, conv[0].name);
check('bot not paused after own echo', conv[0].botPaused === false);
// lead flow
await fetch('http://localhost:9999/__clear');
await webhook(msg('111', 'mid.c2', '我想报名，我叫 Ali 0123456789 ali@example.com')); await sleep(2500);
r = await call('GET', '/api/leads');
check('lead saved', r.j.leads?.[0]?.phone === '0123456789' && r.j.leads[0].email === 'ali@example.com', JSON.stringify(r.j.leads?.[0]));
texts = await sentTexts(); check('lead follow-up reply', texts[0]?.includes('资料已收到'), JSON.stringify(texts));
// AI handoff
await fetch('http://localhost:9999/__clear');
await webhook(msg('111', 'mid.c3', '我有付款问题')); await sleep(2500);
let d = (await call('GET', '/api/conversations/' + cid)).j;
check('ai handoff pauses + needsHuman', d.customer.botPaused && d.customer.needsHuman && d.handoff?.reason === '付款问题', JSON.stringify(d.handoff));
check('auto resume ~12h', Math.abs(d.customer.pausedUntil - Date.now() - 12*3600e3) < 60e3);
texts = await sentTexts(); check('handoff reply sent', texts.length === 1, JSON.stringify(texts));
// while paused, no reply
await fetch('http://localhost:9999/__clear');
await webhook(msg('111', 'mid.c4', '还在吗？')); await sleep(2000);
check('paused → no bot reply', (await sentTexts()).length === 0);
// human replies from dashboard
r = await call('POST', `/api/conversations/${cid}/messages`, { text: '你好，我是 Peko，我来帮你处理付款' });
check('dashboard send', r.status === 200 && (await sentTexts()).length === 1, JSON.stringify(r.j));
d = (await call('GET', '/api/conversations/' + cid)).j;
check('handoff resolved, still paused', !d.customer.needsHuman && d.customer.botPaused && !d.handoff);
// give back to bot
await call('POST', `/api/conversations/${cid}/pause`, { paused: false });
await fetch('http://localhost:9999/__clear');
await webhook(msg('111', 'mid.c5', '谢谢，那课程有回放吗？')); await sleep(2500);
texts = await sentTexts(); check('bot resumes, history includes human msg', texts[0]?.includes('测试回复'), texts[0]);
// human echo from FB inbox (different app id) → pause
await webhook(echo('111', 'mid.human.1', '我是老板，从 FB 回的', 263902037430900)); await sleep(1500);
d = (await call('GET', '/api/conversations/' + cid)).j;
check('FB inbox echo stored as human + paused', d.customer.botPaused && d.messages.some(m => m.role === 'human' && m.text.includes('FB 回的')));
// forbidden keyword
await call('POST', `/api/conversations/${cid}/pause`, { paused: false });
await fetch('http://localhost:9999/__clear');
await webhook(msg('222', 'mid.d1', '我要退款')); await sleep(2500);
texts = await sentTexts();
conv = (await call('GET', '/api/conversations?filter=human')).j;
check('forbidden keyword → greeting skipped? + handoff reply', texts.some(t => t.includes('通知同事')) , JSON.stringify(texts));
check('human filter count', conv.counts.human >= 1);
// tags/notes
r = await call('PATCH', '/api/customers/' + cid, { tags: ['有兴趣', '有兴趣', 'VIP'], notes: '星期六跟进' });
d = (await call('GET', '/api/conversations/' + cid)).j;
check('tags dedup + notes', JSON.stringify(d.customer.tags) === '["有兴趣","VIP"]' && d.customer.notes === '星期六跟进');
// csv
r = await fetch(B + '/api/leads.csv', { headers: { Cookie: cookie } }); const csv = await r.text();
check('csv export', csv.includes('ali@example.com'));
// summary written after ≥12 msgs?
d = (await call('GET', '/api/conversations/' + cid)).j;
check('messages count', d.messages.length >= 10, String(d.messages.length));
// privacy
r = await fetch(B + '/privacy'); check('privacy page', (await r.text()).includes('Ai教育掌握未来'));
// SPA fallback
r = await fetch(B + '/#/inbox'); check('dashboard html', (await r.text()).includes('<div id="root">'));
// agent cannot change settings
await call('POST', '/api/users', { name: 'Staff', email: 'staff@test.com', password: 'password123', role: 'agent' });
cookie=''; await call('POST', '/api/auth/login', { email: 'staff@test.com', password: 'password123' });
check('agent cannot PUT settings', (await call('PUT', '/api/settings', s)).status === 403);
check('agent can read inbox', (await call('GET', '/api/conversations')).status === 200);
console.log(results.join('\n'));
console.log(results.filter(x=>x.startsWith('FAIL')).length + ' failures');
