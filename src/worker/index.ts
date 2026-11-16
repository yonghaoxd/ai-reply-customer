import { Hono } from 'hono';
import type { AppEnv, Env, InboundJob } from './env';
import { receiveWebhook, verifyWebhook } from './webhook';
import { authRoutes, requireAuth, userRoutes } from './auth';
import { api } from './api';
import { processJob } from './bot';
import { privacyPage } from './privacy';
import { runFollowUps } from './followup';
import { serveMedia } from './media';
import { mergeSettings } from '../shared/settings';
import { dailyDemoReset, isDemoSite } from './demo';
import { cleanupAttempts } from './throttle';
import { secureHeaders } from 'hono/secure-headers';
import { DAY, now } from './util';

const DAILY_CRON = '0 19 * * *';

const app = new Hono<AppEnv>();

// 安全 headers：不准别的网站用 iframe 嵌入、不准浏览器乱猜档案类型等
app.use('*', secureHeaders({ crossOriginResourcePolicy: false, crossOriginOpenerPolicy: 'same-origin' }));

// Demo 站没有 Messenger：webhook 和媒体档都不开
app.use('/webhook', async (c, next) => (isDemoSite(c.env) ? c.text('Not found', 404) : next()));
app.use('/media/*', async (c, next) => (isDemoSite(c.env) || !c.env.MEDIA ? c.text('Not found', 404) : next()));

app.get('/webhook', verifyWebhook);
app.post('/webhook', receiveWebhook);
app.get('/privacy', (c) => privacyPage(c.env));
app.get('/media/:key', serveMedia);

app.route('/api/auth', authRoutes);
app.use('/api/*', requireAuth);
app.route('/api/users', userRoutes);
app.route('/api', api);
app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  console.error('unhandled', err);
  return c.json({ error: 'server_error', message: err.message }, 500);
});

// 其它路径交给静态网页（后台 SPA）
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<InboundJob>, env: Env) {
    // 按顺序处理，同一个顾客连发几句时不会乱序
    for (const msg of batch.messages) {
      try {
        await processJob(env, msg.body);
        msg.ack();
      } catch (e) {
        console.error('job failed', (e as Error).message);
        msg.retry({ delaySeconds: 5 });
      }
    }
  },

  // 每天清理：过期 session、旧的去重记录、超过保存期限的对话
  async scheduled(controller: ScheduledController, env: Env) {
    // 每 15 分钟：自动跟进
    if (controller.cron !== DAILY_CRON) {
      const r = await runFollowUps(env);
      if (r.sent) console.log('follow-ups sent', r.sent);
      return;
    }
    const t = now();
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t).run();
    await env.DB.prepare('DELETE FROM processed_events WHERE created_at < ?').bind(t - 7 * DAY).run();
    await cleanupAttempts(env);
    if (isDemoSite(env)) return dailyDemoReset(env);
    const { results } = await env.DB.prepare('SELECT workspace_id, settings_json FROM bot_settings').all<{ workspace_id: string; settings_json: string }>();
    for (const r of results) {
      let days = 0;
      try {
        days = mergeSettings(JSON.parse(r.settings_json)).retentionDays;
      } catch {
        days = 0;
      }
      if (days > 0) {
        await env.DB.prepare('DELETE FROM messages WHERE workspace_id = ? AND created_at < ?').bind(r.workspace_id, t - days * DAY).run();
      }
    }
  },
} satisfies ExportedHandler<Env, InboundJob>;
