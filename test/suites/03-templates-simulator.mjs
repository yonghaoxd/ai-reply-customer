const B = 'http://localhost:8787'; let cookie = '';
const results = []; const check = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`);
async function call(method, path, body, headers = {}, raw) {
  const r = await fetch(B + path, { method, headers: { 'X-Requested-With': 'mcs', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, j };
}
const metaCalls = async () => (await (await fetch('http://localhost:9999/__log')).json()).filter((x) => x.path?.includes('/me/messages'));
await call('POST', '/api/auth/setup', { setupKey: 'setup123', workspaceName: '测试地产', name: 'Peko', email: 'peko@test.com', password: 'password123' });
await call('PUT', '/api/system/deepseek', { apiKey: 'sk-test' });
let s = (await call('GET', '/api/settings')).j.settings; s.llmBaseUrl = 'http://localhost:9999'; s.rateLimitPerMinute = 30; await call('PUT', '/api/settings', s);
// NO FB page connected
let r = await call('POST', '/api/sim/customers', {}); check('create sim customer', r.status === 200);
const id = r.j.id;
r = await call('POST', `/api/sim/customers/${id}/messages`, { text: '你好，想了解一下' }); check('sim message ok without FB page', r.status === 200, JSON.stringify(r.j));
let d = (await call('GET', `/api/conversations/${id}`)).j;
check('greeting + AI reply stored', d.messages.length === 3 && d.messages[1].role === 'bot' && d.messages[2].role === 'bot', d.messages.map((m) => m.role + ':' + m.text.slice(0, 12)).join(' | '));
check('greeting trace', d.messages[1].trace?.type === 'greeting');
const tr = d.messages[2].trace;
check('ai trace has usage/model/ms/stage', tr?.type === 'ai' && tr.usage.prompt === 1234 && tr.usage.completion === 56 && tr.model && tr.rounds === 1 && tr.stageTo === '了解需求', JSON.stringify(tr));
check('customer isSim + named', d.customer.isSim && d.customer.name === '模拟顾客 1');
check('no Meta calls', (await metaCalls()).length === 0);
// media to sim
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const m1 = (await call('PUT', '/api/media?title=' + encodeURIComponent('介绍图'), null, { 'Content-Type': 'image/png' }, png)).j;
await call('POST', `/api/sim/customers/${id}/messages`, { text: '可以看看吗' });
d = (await call('GET', `/api/conversations/${id}`)).j;
check('bot sends media to sim', d.messages.some((m) => m.attachment?.mediaId === m1.id));
const t2 = d.messages.filter((m) => m.trace?.type === 'ai').at(-1).trace;
check('trace tools + rounds 2', t2.tools[0].name === 'send_media' && t2.rounds === 2 && t2.usage.prompt === 2468, JSON.stringify(t2.tools));
// lead
await call('POST', `/api/sim/customers/${id}/messages`, { text: '我要报名 Ali 0123456789' });
check('lead saved from sim', (await call('GET', '/api/leads')).j.leads.length === 1);
// keyword handoff
await call('POST', `/api/sim/customers/${id}/messages`, { text: '我要找真人' });
d = (await call('GET', `/api/conversations/${id}`)).j;
check('keyword handoff + trace', d.customer.botPaused && d.customer.needsHuman && d.messages.at(-1).trace?.type === 'keyword');
// human reply from inbox to sim (no page)
r = await call('POST', `/api/conversations/${id}/messages`, { text: '我是真人' }); check('human reply to sim', r.status === 200, JSON.stringify(r.j));
r = await call('POST', `/api/conversations/${id}/media`, { mediaId: m1.id }); check('human media to sim', r.status === 200, JSON.stringify(r.j));
await call('POST', `/api/sim/customers/${id}/messages`, { text: '还在吗' });
d = (await call('GET', `/api/conversations/${id}`)).j;
check('paused → no bot reply', d.messages.at(-1).role === 'customer');
check('still no Meta calls', (await metaCalls()).length === 0);
check('sim list', (await call('GET', '/api/sim/customers')).j.customers.length === 1);
check('sim msg on non-sim 404', (await call('POST', `/api/sim/customers/nope/messages`, { text: 'x' })).status === 404);
// templates
r = await call('GET', '/api/templates'); check('4 templates', r.j.templates.length === 4, r.j.templates.map((t) => t.id).join(','));
r = await call('POST', '/api/templates/property/apply'); 
check('apply property', r.status === 200 && r.j.settings.botIdentity.startsWith('测试地产的自动客服') && r.j.settings.greeting.includes('测试地产') && r.j.settings.forbiddenTopics[0].includes('保证升值'));
const st = (await call('GET', '/api/sop')).j.stages;
check('sop replaced', st.length === 5 && st[0].name === '了解预算和需求' && st[3].name === '预约看房');
d = (await call('GET', `/api/conversations/${id}`)).j; check('customer stage reset', d.customer.stageId === null);
check('other settings kept', r.j.settings.llmBaseUrl === 'http://localhost:9999' && r.j.settings.rateLimitPerMinute === 30);
check('bad template 404', (await call('POST', '/api/templates/zzz/apply')).status === 404);
// delete
r = await call('DELETE', `/api/sim/customers/${id}`);
check('delete sim + its lead', r.status === 200 && (await call('GET', '/api/sim/customers')).j.customers.length === 0 && (await call('GET', '/api/leads')).j.leads.length === 0);
console.log(results.join('\n')); console.log(results.filter((x) => x.startsWith('FAIL')).length + ' failures');
