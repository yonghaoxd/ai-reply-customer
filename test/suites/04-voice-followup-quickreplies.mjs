import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
const B = 'http://localhost:8787'; let cookie = '';
const results = []; const check = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`);
async function call(method, path, body, headers = {}, raw) {
  const r = await fetch(B + path, { method, headers: { 'X-Requested-With': 'mcs', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, j };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`npx wrangler d1 execute DB --local --persist-to ${process.env.TEST_PERSIST} -c ${process.env.TEST_CONFIG} --command "${q}"`, { stdio: 'pipe' });
const shift = (id, min) => sql(`UPDATE customers SET last_inbound_at = last_inbound_at - ${min * 60000}, last_message_at = last_message_at - ${min * 60000} WHERE id = '${id}'`);
const conv = async (id) => (await call('GET', `/api/conversations/${id}`)).j;
const newSim = async () => (await call('POST', '/api/sim/customers', {})).j.id;
const say = (id, text) => call('POST', `/api/sim/customers/${id}/messages`, { text });
const run = async () => (await call('POST', '/api/followups/run')).j;

await call('POST', '/api/auth/setup', { setupKey: 'setup123', workspaceName: '测试店', name: 'Peko', email: 'peko@test.com', password: 'password123' });
await call('PUT', '/api/system/deepseek', { apiKey: 'sk-test' });
let s = (await call('GET', '/api/settings')).j.settings;
check('defaults: voice on, follow-up off', s.voiceEnabled === true && s.followUpEnabled === false && s.followUpMinutes1 === 180);
s.llmBaseUrl = 'http://localhost:9999'; s.rateLimitPerMinute = 30; s.greetingEnabled = false;
await call('PUT', '/api/settings', s);

// ---------- voice (sim upload) ----------
const a = await newSim();
let r = await call('PUT', `/api/sim/customers/${a}/audio`, null, { 'Content-Type': 'audio/mp4' }, Buffer.alloc(2048, 3));
check('sim audio transcribed', r.status === 200 && r.j.transcript === '我想问课程多少钱', JSON.stringify(r.j));
let d = await conv(a);
check('voice msg stored w/ transcript flag', d.messages[0].role === 'customer' && d.messages[0].text === '我想问课程多少钱' && d.messages[0].attachment?.type === 'audio' && d.messages[0].attachment.transcript === true && !d.messages[0].attachment.url);
check('bot answered the transcript (set_stage path)', d.messages[1]?.role === 'bot' && d.messages[1].text.includes('RM 99'), d.messages[1]?.text);
const llm = (await (await fetch('http://localhost:9999/__log')).json()).filter((x) => x.path === '/chat/completions');
check('LLM told it is a voice transcript', llm[0].body.messages.some((m) => m.role === 'user' && m.content.includes('语音') && m.content.includes('我想问课程多少钱')));
r = await call('PUT', `/api/sim/customers/${a}/audio`, null, { 'Content-Type': 'audio/mp4' }, Buffer.alloc(9 * 1024 * 1024, 1));
check('audio too big rejected', r.status === 400, r.j.message);
// voice disabled → not transcribed, goes to AI as placeholder
await call('PUT', '/api/settings', { ...s, voiceEnabled: false });
r = await call('PUT', `/api/sim/customers/${a}/audio`, null, { 'Content-Type': 'audio/mp4' }, Buffer.alloc(100, 3));
d = await conv(a);
const cm = d.messages.filter((m) => m.role === 'customer').at(-1);
check('voice disabled → placeholder text, no transcript', r.j.transcript === null && cm.text === '[顾客发了语音]' && cm.attachment?.type === 'audio' && !cm.attachment.transcript && !cm.attachment.url, JSON.stringify(cm.attachment));
await call('PUT', '/api/settings', s);

// ---------- voice (real webhook path) ----------
await call('PUT', '/api/system/page', { pageToken: 'EAAtest' });
async function webhook(att) {
  const raw = JSON.stringify({ object: 'page', entry: [{ id: 'PAGE1', messaging: [{ sender: { id: '777' }, recipient: { id: 'PAGE1' }, timestamp: Date.now(), message: { mid: 'mid.' + Math.random(), attachments: [att] } }] }] });
  await fetch(B + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', 'testsecret').update(raw).digest('hex') }, body: raw });
}
await webhook({ type: 'audio', payload: { url: 'http://localhost:9999/audio.mp4' } }); await sleep(3000);
let real = (await call('GET', '/api/conversations')).j.conversations.find((c) => c.psid === '777');
d = await conv(real.id);
check('webhook audio → transcribed + answered', d.messages[0].text === '我想问课程多少钱' && d.messages[0].attachment.transcript === true && d.messages[1]?.role === 'bot', d.messages.map((m) => m.role + ':' + m.text).join(' | '));
await webhook({ type: 'audio', payload: { url: 'http://localhost:9999/missing.mp4' } }); await sleep(3000);
d = await conv(real.id);
const last2 = d.messages.slice(-2);
check('download fails → fixed voice-fail reply, no AI', last2[0].text === '[顾客发了语音]' && last2[1].role === 'bot' && last2[1].text.includes('打字') && last2[1].trace?.type === 'voice_failed', last2.map((m) => m.text).join(' | '));

// ---------- follow-up ----------
const b = await newSim(); await say(b, '你好想了解');
check('disabled → nothing sent', (await run()).sent === 0);
s = { ...s, followUpEnabled: true, followUpCount: 2, followUpMinutes1: 60, followUpMinutes2: 600 };
r = await call('PUT', '/api/settings', s); s = r.j.settings;
check('not due yet → nothing', (await run()).sent === 0);
shift(b, 61);
// stage-specific text
const st = (await call('GET', '/api/sop')).j.stages; st[0].followUp = '【步骤1专用跟进】';
r = await call('PUT', '/api/sop', { stages: st }); check('stage followUp saved', r.j.stages[0].followUp === '【步骤1专用跟进】');
let out = await run();
d = await conv(b);
check('1st follow-up uses stage text', out.sent >= 1 && d.messages.at(-1).text === '【步骤1专用跟进】' && d.messages.at(-1).trace?.type === 'followup' && d.messages.at(-1).trace.n === 1, d.messages.at(-1).text);
check('run again → no duplicate', (await run()).sent === 0);
shift(b, 300); check('2nd not due at 6h', (await run()).sent === 0);
shift(b, 260); out = await run(); d = await conv(b);
check('2nd follow-up uses final text', out.sent === 1 && d.messages.at(-1).text === s.followUpText2 && d.messages.at(-1).trace.n === 2);
shift(b, 120); check('max 2 → no 3rd', (await run()).sent === 0);
// customer replies → resets
await say(b, '还在的'); shift(b, 61); out = await run(); d = await conv(b);
check('reply resets count → follow-up again', out.sent === 1 && d.messages.at(-1).trace?.n === 1);
// window closed
const c = await newSim(); await say(c, '你好'); shift(c, 24 * 60); check('outside 24h window → none', (await run()).sent === 0);
// paused / needs human
const e = await newSim(); await say(e, '我要找真人'); shift(e, 61); check('handoff → none', (await run()).sent === 0);
// has lead
const f = await newSim(); await say(f, '我要报名 Ali 0123456789'); shift(f, 61); check('has lead → none', (await run()).sent === 0);
// human spoke last, bot resumed
const g = await newSim(); await say(g, '你好'); await call('POST', `/api/conversations/${g}/messages`, { text: '真人回复' }); await call('POST', `/api/conversations/${g}/pause`, { paused: false }); shift(g, 61);
check('human spoke last → none', (await run()).sent === 0);
// default text when stage has none
const h = await newSim(); await say(h, '你好'); await call('POST', `/api/conversations/${h}/stage`, { stageId: st[1].id }); shift(h, 61); await run(); d = await conv(h);
check('default text when stage has none', d.messages.at(-1).text === s.followUpText, d.messages.at(-1).text);
// clamp
r = await call('PUT', '/api/settings', { ...s, followUpCount: 9, followUpMinutes1: 1, followUpMinutes2: 2 });
check('settings clamped', r.j.settings.followUpCount === 2 && r.j.settings.followUpMinutes1 === 5 && r.j.settings.followUpMinutes2 === 35, JSON.stringify([r.j.settings.followUpCount, r.j.settings.followUpMinutes1, r.j.settings.followUpMinutes2]));

// ---------- quick replies ----------
r = await call('POST', '/api/quick-replies', { title: '付款方式', text: '可以银行转账或 TNG。' }); const q = r.j.id;
check('qr create', r.status === 200);
check('qr empty rejected', (await call('POST', '/api/quick-replies', { title: 'x', text: '  ' })).status === 400);
await call('POST', '/api/quick-replies', { text: '没有名称的回复内容会自动拿前面的字当名称' });
await call('PATCH', `/api/quick-replies/${q}`, { text: '改过的内容' });
r = await call('GET', '/api/quick-replies');
check('qr list/patch/auto title', r.j.replies.length === 2 && r.j.replies[0].text === '改过的内容' && r.j.replies[0].title === '付款方式' && r.j.replies[1].title.length === 20, JSON.stringify(r.j.replies.map((x) => x.title)));
await call('DELETE', `/api/quick-replies/${q}`); check('qr delete', (await call('GET', '/api/quick-replies')).j.replies.length === 1);
console.log(results.join('\n')); console.log(results.filter((x) => x.startsWith('FAIL')).length + ' failures');
