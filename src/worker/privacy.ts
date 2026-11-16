// 公开的隐私政策页（Meta App Review 需要）。内容按你的情况修改。
import type { Env } from './env';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function privacyPage(env: Env): Promise<Response> {
  const ws = await env.DB.prepare('SELECT id, name FROM workspaces ORDER BY created_at LIMIT 1').first<{ id: string; name: string }>();
  const settingsRow = ws
    ? await env.DB.prepare('SELECT settings_json FROM bot_settings WHERE workspace_id = ?').bind(ws.id).first<{ settings_json: string }>()
    : null;
  let retention = 365;
  try {
    retention = JSON.parse(settingsRow?.settings_json || '{}').retentionDays ?? 365;
  } catch {
    /* ignore */
  }
  const name = esc(ws?.name || 'Our business');
  const keep = retention > 0 ? `${retention} 天 / ${retention} days` : '直到你要求删除 / until you ask us to delete it';
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>隐私政策 Privacy Policy — ${name}</title>
<style>body{font:16px/1.65 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1f2328}h1{font-size:26px}h2{font-size:18px;margin-top:28px}.en{color:#57606a}</style></head><body>
<h1>隐私政策 / Privacy Policy</h1>
<p><strong>${name}</strong> 使用自动客服系统回复 Facebook Messenger 信息。本页说明我们收集哪些资料、怎么使用。</p>
<p class="en">${name} uses an automated customer-service system to reply to Facebook Messenger messages. This page explains what data we collect and how we use it.</p>
<h2>我们收集的资料 / Data we collect</h2>
<ul><li>你在 Messenger 发给我们的信息内容 / Messages you send us on Messenger</li>
<li>你的 Facebook 公开名字和头像 / Your public Facebook name and profile picture</li>
<li>你自愿提供的名字、电话、email / Name, phone number and email you choose to give us</li></ul>
<h2>用途 / How we use it</h2>
<ul><li>回答你的问题、介绍课程、协助报名 / To answer questions, introduce our courses and help you sign up</li>
<li>让我们的同事跟进你的询问 / So our team can follow up on your enquiry</li></ul>
<p>你的信息会经由 AI 服务（DeepSeek）处理以生成回复。我们不会出售你的资料。<br><span class="en">Your messages are processed by an AI service (DeepSeek) to generate replies. We do not sell your data.</span></p>
<h2>保存期限 / Retention</h2>
<p>对话记录保存 ${keep}。 / Conversation records are kept for ${keep}.</p>
<h2>删除资料 / Data deletion</h2>
<p>在 Messenger 发「删除我的资料」给我们，或联系专页管理员，我们会在 30 天内删除你的对话和联系资料。<br>
<span class="en">Send "delete my data" to us on Messenger or contact the Page admin, and we will delete your conversations and contact details within 30 days.</span></p>
<p class="en" style="margin-top:40px;font-size:14px">Last updated: ${new Date().toISOString().slice(0, 10)}</p>
</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
