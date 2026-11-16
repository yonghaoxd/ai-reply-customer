# Messenger AI 客服系统

在 Facebook Page 上用 AI（DeepSeek）自动回复 Messenger。后台网页可以调语气、加知识库、设禁区，也可以直接跟顾客聊天、接管对话、看 leads。
全部跑在 **Cloudflare Workers 免费版**上。

English overview and architecture: [README.md](README.md)

---

## 一、准备好这些账号

| 需要 | 哪里拿 |
| --- | --- |
| Node.js 20 以上 | https://nodejs.org （装 LTS 版） |
| Cloudflare 账号（免费） | https://dash.cloudflare.com |
| Meta 开发者账号 + 你的 FB Page 的管理员权限 | https://developers.facebook.com |
| DeepSeek API key | https://platform.deepseek.com |
| Telegram（可选，用来通知你） | 手机装 Telegram，找 @BotFather 开一个 bot |

---

## 二、第一次部署（大约 20 分钟）

在这个文件夹打开终端机（Windows：在文件夹空白处按住 Shift + 右键 → 「在终端中打开」），然后按顺序执行。

### 1. 安装

```bash
npm install
npx wrangler login
```

`wrangler login` 会打开浏览器，登入 Cloudflare 并按「Allow」。

然后把配置范本复制一份（Windows 用 `copy`）：

```bash
copy wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc` 有你自己的网址和资源 id，不会上传到 GitHub。

### 2. 建数据库、队列和媒体存储

```bash
npx wrangler d1 create messenger-ai-cs
npx wrangler queues create messenger-inbound
npx wrangler kv namespace create MEDIA
```

- 第一个命令会显示 `database_id`：打开 `wrangler.jsonc`，把 `REPLACE_WITH_YOUR_D1_DATABASE_ID` 换成它。
- 第三个命令会显示一个 `id`：把 `REPLACE_WITH_YOUR_KV_ID` 换成它（产品图片和视频存在这里）。

然后建表：

```bash
npm run db:migrate:remote
```

### 3. 设定机密（四个）

每个命令执行后，它会叫你输入值：

```bash
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_VERIFY_TOKEN
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put SETUP_KEY
```

| 名字 | 填什么 |
| --- | --- |
| `META_APP_SECRET` | Meta App → 应用设置 → 基本 → 应用密钥（第三步建好 App 再回来填也可以） |
| `META_VERIFY_TOKEN` | 自己定一串字，例如 `peko-verify-2026`，等下 Meta 设 webhook 时填同一串 |
| `ENCRYPTION_KEY` | 一串够长的乱码（至少 32 个字），用来加密 Page token 和 API key。**设定后不要改**，不然已存的 token 会读不到 |
| `SETUP_KEY` | 自己定一串字，第一次在后台建老板账号时要输入，防止别人抢先注册 |

### 4. 部署

```bash
npm run deploy
```

完成后会显示网址，例如 `https://messenger-ai-cs.xxxx.workers.dev`。

打开 `wrangler.jsonc`，填两个值：

- `APP_URL`：刚才的网址
- `META_APP_ID`：Meta App 的应用编号

然后再 `npm run deploy` 一次。

### 5. 建老板账号

用浏览器打开你的网址，输入 `SETUP_KEY`、名字、email、密码。

---

## 三、连接 Facebook（Meta App）

1. 到 https://developers.facebook.com/apps → **建立应用** → 选「商家（Business）」类型。
2. 在应用里加入 **Messenger** 产品。
3. **Messenger → Messenger API 设置**：
   - 「生成访问口令」：选「Ai教育掌握未来」Page，复制 Page access token。
   - 到后台 **系统设定 → Facebook Page** 贴上，按「连接」。系统会自动把 Page 订阅到你的 App。
   - 「配置 Webhook」：
     - 回调网址：后台系统设定显示的 Webhook 网址（`https://你的网址/webhook`）
     - 验证口令：你设的 `META_VERIFY_TOKEN`
     - 订阅字段：勾 `messages`、`messaging_postbacks`、`message_echoes`
4. **应用设置 → 基本**：
   - 复制「应用密钥」→ `npx wrangler secret put META_APP_SECRET`
   - 「隐私政策网址」填 `https://你的网址/privacy`

> App 还在开发模式时，只有 Page 管理员和你加的「测试人员」发信息，bot 才会回。自己测试没问题后，再申请 App Review（`pages_messaging`），通过后所有顾客都能收到回复。

---

## 四、在后台设定

1. **系统设定**：
   - 填 DeepSeek API key。
   - （可选）设 Telegram：
     1. 贴上 bot token。
     2. 在 Telegram 跟你的 bot 说一句话。
     3. 按「找我的 Chat ID」。
     4. 勾「启用」。
     5. 发测试通知。
2. **产品**：三个课程已经建好。请填价钱、介绍、卖点和常见问题，上传介绍图片或视频，**说明要写清楚**（AI 靠说明判断什么时候发）。没填价钱时，bot 不会报价。
3. **销售 SOP**：已经有 5 个默认步骤（了解需求 → 推荐产品 → 解答疑问 → 促成报名 → 跟进），可以改话术，也可以指定某一步一定要发哪些图片或视频。
4. **知识库**：贴常见问题，或上传 PDF / Word。
5. **Bot 设定**：调语气、禁区、开场白，用右边的「测试聊天」试，会显示顾客走到 SOP 哪一步、发了哪些图片。满意了按「保存」。
6. 用你自己的 FB 账号去 Page 发信息测试。

---

## 不用 Meta App 也能测试：模拟顾客

后台左边的「**模拟顾客**」页面可以扮演顾客发信息。流程跟真顾客完全一样（Inbox、转真人、Leads、Telegram 通知、SOP 进度），只是信息不会发去 Messenger。只需要填好 DeepSeek API key 就能用。

- 每句 bot 回复下面有「详情」，可以看到它参考了哪些知识库资料、调用了什么工具、用了多少 token 和时间。Inbox 里也有。
- 「Bot 设定」最上面的「行业模板」可以一键换成线上课程、房地产、美容院或零售的 bot 身份和销售 SOP。

- 聊天框旁边的 🎤 可以上传一段语音档（mp3、m4a、wav 等，最多 8MB），测试语音转文字。

---

## 语音、自动跟进、快捷回复

- **语音**：顾客发语音时，系统用 Cloudflare Workers AI 的 Whisper 转成文字再回答，Inbox 会标出「🎤 语音转文字」。转不到时（额度用完、太长、听不清），bot 会用固定的一句话请顾客打字。在「Bot 设定 → 语音信息」可以关掉或改这句话。
- **自动跟进**：默认关闭，在「Bot 设定 → 自动跟进」打开。可以设最多跟进几次（1 或 2）和几分钟后跟进。每个 SOP 步骤可以在「销售 SOP」页写自己的跟进话术。只在顾客最后一句话后的 24 小时内发；真人接管中、顾客已留资料、或最后一句是真人说的都不会发。定时任务每 15 分钟检查一次；测试时可以按「马上检查一次」。
- **快捷回复**：Inbox 输入框下面的「快捷回复」按钮。点一条会把内容填进输入框，可以改了再发；也在同一个地方新增、修改、删除。

---

## 数据报表、AI 评测、公开 Demo

- **数据报表**：每天的信息量、留资料率、bot 自己解决和有真人参与的比例、销售 SOP 漏斗、AI 平均回复时间和用量。可以选最近 7、14 或 30 天，也可以不算模拟顾客。
- **AI 评测**：一组固定的测试题，每题写明期望（一定要转真人、回复一定要有某个字、不可以报价、一定要保存顾客资料，或写一句标准让 AI 评审）。改了 Bot 设定、SOP 或知识库之后按「跑全部测试」，看通过率有没有掉。可以先按「载入 8 题示范题」，再加自己生意的题目。
- **公开 Demo 站**：另外部署的一个网站（`wrangler.demo.jsonc`），有自己的数据库和自己的 DeepSeek key，里面只有虚构的房地产示范资料，跟你自己用的站完全分开。访客打开就直接进去，不用登入；只能看、用模拟顾客聊天和跑评测，不能改任何东西。每天 AI 上限默认 100 次（在 `wrangler.demo.jsonc` 的 `DEMO_DAILY_CAP` 改），每天凌晨自动重置。部署方法见下面「公开 Demo 站」。

---

## 公开 Demo 站（给面试官 / 客户看）

跟你自己的站是**两个分开的网站**，用同一份代码部署两次。Demo 站被攻破也只会拿到假资料。

```bash
npx wrangler d1 create messenger-ai-cs-demo
```

把显示的 `database_id` 填进 `wrangler.demo.jsonc` 的 `REPLACE_WITH_DEMO_D1_DATABASE_ID`，然后：

```bash
npm run db:migrate:demo
npx wrangler secret put DEMO_DEEPSEEK_KEY -c wrangler.demo.jsonc
npm run deploy:demo
```

`DEMO_DEEPSEEK_KEY` 建议在 DeepSeek 另开一个 key，只充少少钱。以后改了代码，两个站都要部署：`npm run deploy` 和 `npm run deploy:demo`。

---

## 登入保护

- 同一个 email 输错 5 次密码，锁 15 分钟；同一个 IP 输错 20 次，锁 30 分钟。
- 你自己的站没有 Demo 入口，也不要把它的网址放在履历或 GitHub。
- 忘记密码：`node reset-password.mjs`。

---

## 五、日常使用

- **Inbox**：「待真人」页签是 bot 转给你的对话。你在后台回复后，这个顾客会自动转为真人接管；默认 12 小时后交还 bot，可以在 Bot 设定里关掉或改时间。
- **Telegram**：有人要求真人、或有新 lead 时会通知你。
- **Leads**：可改状态，也可导出 CSV。
- **Inbox 右边**可以看到、也可以手动改顾客的 SOP 步骤；按「发图片 / 视频」可以从产品库挑一个发给顾客。

---

## 六、免费版的限制

| 项目 | 免费额度 | 大约够用 |
| --- | --- | --- |
| Workers 请求 | 每天 10 万次 | 很够 |
| Queues | 每天 1 万次操作 | 每天约 3,000 条顾客信息 |
| D1 | 5 GB，每天写入 10 万行 | 很够 |
| CPU | 每次 10ms（等 DeepSeek 的时间不算） | 正常使用够 |
| Workers AI（知识库向量） | 每天有免费额度 | 知识库几百段以内够 |
| KV（产品图片 / 视频） | 1 GB，每个档案最多 25MB，每天写入 1,000 次 | 几十个产品的图片和短视频够用 |

顾客量变大时，到 Cloudflare 升级 Workers Paid（USD 5/月）就好，代码不用改。

---

## 七、更新代码

```bash
npm run deploy
```

以后数据库结构有变动时（`migrations/` 多了新文件），先执行：

```bash
npm run db:migrate:remote
```

## 八、本地开发和测试

```bash
cp wrangler.example.jsonc wrangler.jsonc   # 第一次才需要（你电脑上已经有了）
cp .dev.vars.example .dev.vars   # 填上测试用的值
npm run db:migrate:local
npm run dev                      # http://localhost:8787
```

本地不能用 Workers AI，所以知识库会自动改用关键词检索。

自动测试（用假的 Meta 和假的 AI，不会花钱）：

```bash
npm test
```

---

## 文件结构

```
migrations/                数据库（每张表都有 workspace_id，以后可以多用户）
src/worker/                后端（Cloudflare Worker）
  index.ts                 路由、队列、每日清理
  webhook.ts               Meta webhook：验证签名 → 放进队列
  bot.ts                   AI 回复核心：转真人、开场白、防刷屏、工具、摘要
  kb.ts                    知识库：拆段、向量、检索
  media.ts                 产品图片 / 视频：上传、公开网址、发给顾客
  seed.ts                  新账号的默认产品和销售 SOP
  api.ts                   后台 API
  auth.ts                  登入、员工账号
  meta.ts / telegram.ts    外部服务
  followup.ts / voice.ts   自动跟进、语音转文字
  insights.ts              数据报表、AI 评测
  demo.ts                  公开 Demo 站：示范资料、每日上限、每天重置
  throttle.ts              登入保护
  privacy.ts               隐私政策页
src/web/                   后台网页（React，中英切换）
src/shared/settings.ts     Bot 设定的默认值
```
