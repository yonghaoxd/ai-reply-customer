import crypto from 'node:crypto';
const B = 'http://localhost:8787';
let cookie = '';
const results = [];
const check = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
async function call(method, path, body, headers = {}, raw) {
  const r = await fetch(B + path, { method, headers: { 'X-Requested-With': 'mcs', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { status: r.status, j };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function webhook(payload) {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'testsecret').update(raw).digest('hex');
  return (await fetch(B + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw })).status;
}
const msg = (psid, mid, text, attachments) => ({ object: 'page', entry: [{ id: 'PAGE1', messaging: [{ sender: { id: psid }, recipient: { id: 'PAGE1' }, timestamp: Date.now(), message: attachments ? { mid, attachments } : { mid, text } }] }] });
const mock = async () => (await fetch('http://localhost:9999/__log')).json();
const clear = () => fetch('http://localhost:9999/__clear');
const sends = async () => (await mock()).filter((x) => x.path?.endsWith('/me/messages') && x.body?.message);

await call('POST', '/api/auth/setup', { setupKey: 'setup123', workspaceName: 'Ai教育掌握未来', name: 'Peko', email: 'peko@test.com', password: 'password123' });
await call('PUT', '/api/system/page', { pageToken: 'EAAtest' });
await call('PUT', '/api/system/deepseek', { apiKey: 'sk-test' });
let s = (await call('GET', '/api/settings')).j.settings; s.llmBaseUrl = 'http://localhost:9999'; s.rateLimitPerMinute = 30;
await call('PUT', '/api/settings', s);

// products
let r = await call('GET', '/api/products');
check('3 seeded products', r.j.products.length === 3, r.j.products.map((p) => p.name).join(','));
const p2 = r.j.products[1];
r = await call('PATCH', `/api/products/${p2.id}`, { price: 'RM 99', sellingPoints: '每条回复都不一样\n24 小时', faq: 'Q：要电脑吗？\nA：要', category: '课程' });
r = await call('GET', '/api/products');
const p2b = r.j.products.find((p) => p.id === p2.id);
check('product patch', p2b.price === 'RM 99' && p2b.selling_points.includes('24 小时') && p2b.category === '课程');
r = await call('POST', '/api/products', { name: '测试产品', price: '' });
check('create product, blank price → null', r.status === 200 && (await call('GET', '/api/products')).j.products.find((p) => p.name === '测试产品').price === null);

// media upload
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
r = await call('PUT', `/api/media?productId=${p2.id}&title=${encodeURIComponent('评论自动回复截图')}`, null, { 'Content-Type': 'image/png' }, png);
check('upload image', r.status === 200, JSON.stringify(r.j));
const img = r.j;
r = await call('PUT', `/api/media?productId=${p2.id}&title=${encodeURIComponent('课程介绍视频')}`, null, { 'Content-Type': 'video/mp4' }, Buffer.alloc(2048, 1));
check('upload video', r.status === 200);
const vid = r.j;
r = await call('PUT', `/api/media?title=${encodeURIComponent('付款方式')}`, null, { 'Content-Type': 'image/png' }, png);
const general = r.j;
check('upload general media', r.status === 200);
r = await call('PUT', `/api/media?title=x`, null, { 'Content-Type': 'application/pdf' }, Buffer.from('x'));
check('reject pdf', r.status === 400, r.j.message);
const served = await fetch(img.url);
check('public media url served', served.status === 200 && served.headers.get('content-type') === 'image/png' && (await served.arrayBuffer()).byteLength === png.length);
check('bad media key 404', (await fetch(B + '/media/../api/settings')).status !== 200);
const mediaList = (await call('GET', '/api/media')).j.media;
check('media list 3', mediaList.length === 3);

// SOP
r = await call('GET', '/api/sop');
check('5 default stages', r.j.stages.length === 5, r.j.stages.map((x) => x.name).join('>'));
const stages = r.j.stages;
stages[2].mediaIds = [vid.id, 'bogus'];
r = await call('PUT', '/api/sop', { stages });
check('sop save drops invalid media id', r.status === 200 && JSON.stringify(r.j.stages[2].mediaIds) === JSON.stringify([vid.id]));

// conversation flow
await clear();
await webhook(msg('111', 'mid.1', '你好，我想了解一下')); await sleep(2500);
let out = await sends();
check('greeting + reply', out.length === 2 && out[1].body.message.text.includes('[SOP第1步]') && out[1].body.message.text.includes('[有产品]') && out[1].body.message.text.includes('[有媒体]'), out.map((x) => x.body.message.text).join(' | '));
let conv = (await call('GET', '/api/conversations')).j.conversations[0];
check('stage set to step 1', conv.stageId === stages[0].id);
await clear();
await webhook(msg('111', 'mid.2', '可以看看介绍吗')); await sleep(3000);
out = await sends();
const types = out.map((x) => x.body.message.attachment ? x.body.message.attachment.type : 'text');
check('text then 2 images (dedup, max 2)', JSON.stringify(types) === '["text","image","image"]', JSON.stringify(types));
const fetched = (await mock()).filter((x) => x.fetched);
check('Meta fetched media urls ok', fetched.length === 2 && fetched.every((f) => f.status === 200), JSON.stringify(fetched.map((f) => [f.status, f.type, f.bytes])));
let d = (await call('GET', '/api/conversations/' + conv.id)).j;
check('sent_media recorded', d.customer.sentMedia.length === 2);
check('attachment messages stored', d.messages.filter((m) => m.attachment?.mediaId).length === 2 && d.messages.some((m) => m.attachment?.title === '付款方式') && d.messages.some((m) => m.attachment?.title === '评论自动回复截图'));
await clear();
await webhook(msg('111', 'mid.3', '这个多少钱')); await sleep(3000);
out = await sends();
const t3 = out.map((x) => x.body.message.attachment ? 'att:' + (x.body.message.attachment.payload.url || '').split('/').pop() : x.body.message.text);
check('set_stage → stage 3 + auto-send stage video', t3.length === 2 && t3[0].includes('RM 99') && t3[1].endsWith('.mp4'), JSON.stringify(t3));
d = (await call('GET', '/api/conversations/' + conv.id)).j;
check('stage now step 3', d.customer.stageId === stages[2].id);
// human sends image again from dashboard → uses cached attachment_id
await clear();
r = await call('POST', `/api/conversations/${conv.id}/media`, { mediaId: img.id });
out = await sends();
check('dashboard media send uses attachment_id', r.status === 200 && out[0]?.body.message.attachment.payload.attachment_id?.startsWith('att_'), JSON.stringify(out[0]?.body.message.attachment));
d = (await call('GET', '/api/conversations/' + conv.id)).j;
check('dashboard media send pauses bot', d.customer.botPaused);
// manual stage
r = await call('POST', `/api/conversations/${conv.id}/stage`, { stageId: stages[4].id });
d = (await call('GET', '/api/conversations/' + conv.id)).j;
check('manual stage change', d.customer.stageId === stages[4].id);
// customer image
await call('POST', `/api/conversations/${conv.id}/pause`, { paused: false });
await webhook(msg('111', 'mid.4', null, [{ type: 'image', payload: { url: 'https://example.com/receipt.jpg' } }])); await sleep(2500);
d = (await call('GET', '/api/conversations/' + conv.id)).j;
check('customer image stored with url', d.messages.some((m) => m.role === 'customer' && m.attachment?.url === 'https://example.com/receipt.jpg'));
// test chat
r = await call('POST', '/api/test-chat', { messages: [{ role: 'customer', text: '可以看看吗' }], stageId: null, sentMedia: [] });
check('test chat returns media + stage', r.j.media?.length === 2 && r.j.stageName === '了解需求', JSON.stringify({ m: r.j.media?.map((m) => m.title), st: r.j.stageName }));
r = await call('POST', '/api/test-chat', { messages: [{ role: 'customer', text: '这个多少钱' }], stageId: stages[0].id, sentMedia: [] });
check('test chat stage media', r.j.stageName === '解答疑问' && r.j.media.some((m) => m.title === '课程介绍视频'), JSON.stringify(r.j.media?.map((m) => m.title)));
// delete media → removed from SOP
await call('DELETE', `/api/media/${vid.id}`);
r = await call('GET', '/api/sop');
check('deleted media removed from stage', r.j.stages[2].mediaIds.length === 0);
check('deleted media 404', (await fetch(vid.url)).status === 404);
// delete product deletes its media
await call('DELETE', `/api/products/${p2.id}`);
{ const ml = (await call('GET', '/api/media')).j.media; const st = (await fetch(img.url)).status; check('product delete removes its media, keeps general media', ml.length === 1 && ml[0].id === general.id && st === 404, JSON.stringify({ left: ml.map((m) => m.productId + ':' + m.title), st, p2: p2.id })); }
// sop delete stage clears customers
const st2 = (await call('GET', '/api/sop')).j.stages;
await call('PUT', '/api/sop', { stages: st2.slice(0, 4) });
d = (await call('GET', '/api/conversations/' + conv.id)).j;
check('deleting stage clears customer stage', d.customer.stageId === null && (await call('GET', '/api/sop')).j.stages.length === 4);
console.log(results.join('\n'));
console.log(results.filter((x) => x.startsWith('FAIL')).length + ' failures');
