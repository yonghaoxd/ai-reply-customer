// Mock Meta Graph API + DeepSeek（OpenAI 兼容）for local tests. Run by test/run.mjs on :9999.
import http from 'node:http';
const log = [];
let n = 0;
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const ch of req) body += ch;
  const url = new URL(req.url, 'http://x');
  const json = body ? JSON.parse(body) : null;
  log.push({ method: req.method, path: url.pathname, body: json });
  const send = (o, code = 200) => { if (o && o.choices) o.usage = { prompt_tokens: 1234, completion_tokens: 56 }; res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/audio.mp4') { res.writeHead(200, { 'Content-Type': 'audio/mp4' }); return res.end(Buffer.alloc(4096, 7)); }
  if (url.pathname === '/__log') return send(log);
  if (url.pathname === '/__clear') { log.length = 0; return send({ ok: true }); }
  // DeepSeek
  if (url.pathname === '/chat/completions') {
    const msgs = json.messages;
    const sys = msgs[0].content;
    const last = msgs[msgs.length - 1];
    if (last.role === 'tool') {
      const tc = msgs[msgs.length - 2].tool_calls?.[0]?.function?.name;
      const reply = tc === 'send_media' ? '我发介绍给你看 👇' : tc === 'set_stage' ? '价钱是 RM 99 哦。' : '好的，资料已收到，同事会联系你！';
      return send({ choices: [{ message: { role: 'assistant', content: reply } }] });
    }
    const u = last.content || '';
    if (!json.tools && sys.includes('质检员')) return send({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ pass: u.includes('PASSME'), reason: 'mock judge' }) } }] });
    if (!json.tools) return send({ choices: [{ message: { role: 'assistant', content: '顾客想学评论自动回复，已留电话。' } }] });
    const stageM = sys.match(/这个顾客现在在第 (\d+) 步/);
    const stageTag = stageM ? `[SOP第${stageM[1]}步]` : '[无SOP]';
    if (u.includes('看看')) return send({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't3', type: 'function', function: { name: 'send_media', arguments: JSON.stringify({ codes: ['m1', 'm2', 'm1'] }) } }] } }] });
    if (u.includes('多少钱')) return send({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't4', type: 'function', function: { name: 'set_stage', arguments: JSON.stringify({ stage: 3 }) } }] } }] });
    if (u.includes('报名')) return send({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'save_lead', arguments: JSON.stringify({ name: 'Ali', phone: '0123456789', email: 'ali@example.com', interest: '评论自动回复' }) } }] } }] });
    if (u.includes('付款问题')) return send({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't2', type: 'function', function: { name: 'handoff_to_human', arguments: JSON.stringify({ reason: '付款问题' }) } }] } }] });
    const kbHit = sys.includes('星期六') ? '[KB命中]' : '[KB没命中]';
    const hasCourse = sys.includes('评论自动回复') ? '[有课程]' : '';
    const hasProd = sys.includes('## 产品资料') && sys.includes('评论自动回复') ? '[有产品]' : '';
    const hasMedia = sys.includes('m1｜') ? '[有媒体]' : '';
    return send({ choices: [{ message: { role: 'assistant', content: `**测试回复**：${u} ${kbHit}${hasProd}${hasMedia}${stageTag} 历史${msgs.length - 1}条` } }] });
  }
  // Meta
  const p = url.pathname.replace(/^\/v\d+\.\d+/, '');
  if (p === '/me' && req.method === 'GET') return send({ id: 'PAGE1', name: 'Test Page' });
  if (p === '/PAGE1/subscribed_apps') return send({ success: true });
  if (p === '/me/messages') {
    if (json.sender_action) return send({ recipient_id: json.recipient.id });
    const att = json.message?.attachment;
    if (att) {
      if (att.payload.url) {
        // 模拟 Meta 去抓档案
        const r = await fetch(att.payload.url); const b = await r.arrayBuffer();
        log.push({ fetched: att.payload.url, status: r.status, bytes: b.byteLength, type: r.headers.get('content-type') });
        if (!r.ok) return send({ error: { message: 'cannot fetch' } }, 400);
        return send({ recipient_id: json.recipient.id, message_id: 'mid.bot.' + (++n), attachment_id: 'att_' + n });
      }
      return send({ recipient_id: json.recipient.id, message_id: 'mid.bot.' + (++n) });
    }
    return send({ recipient_id: json.recipient.id, message_id: 'mid.bot.' + (++n) });
  }
  if (/^\/\d+$/.test(p)) return send({ name: 'Ali Test', first_name: 'Ali', profile_pic: 'https://example.com/a.jpg' });
  send({ error: { message: 'mock: unknown ' + p } }, 404);
});
server.listen(9999, () => console.log('mock on 9999'));
