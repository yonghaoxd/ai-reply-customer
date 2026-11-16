// 新 workspace 的初始资料：产品（原本的三个课程）+ 默认销售 SOP。后台都可以改。
import { newId, now } from './util';
import { getTemplate } from '../shared/templates';

const SIGNUP_URL = 'https://course-studio.showtv1688ai-courses.workers.dev/?lang=zh-CN';

// 介绍和价钱留空，请在后台「产品」页填写；没填的部分 bot 不会乱讲
const PRODUCTS = ['📊 直播数据分析', '💬 评论自动回复', '📩 Message 私信自动回复'];

export const DEFAULT_STAGES = getTemplate('course')!.stages;

export async function seedWorkspace(db: D1Database, wsId: string) {
  const t = now();
  await db.batch([
    ...PRODUCTS.map((name, i) =>
      db
        .prepare(
          'INSERT INTO products (id, workspace_id, name, price, link_url, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 1, ?, ?, ?)',
        )
        .bind(newId('p_'), wsId, name, SIGNUP_URL, i, t, t),
    ),
    ...DEFAULT_STAGES.map((st, i) =>
      db
        .prepare(
          'INSERT INTO sop_stages (id, workspace_id, sort_order, name, goal, script, exit_when, media_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(newId('s_'), wsId, i, st.name, st.goal, st.script, st.exit_when, '[]', t, t),
    ),
  ]);
}
