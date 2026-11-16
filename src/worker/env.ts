export interface Env {
  DB: D1Database;
  AI: Ai;
  INBOUND: Queue<InboundJob>;
  MEDIA: KVNamespace; // 产品图片 / 视频
  ASSETS: Fetcher;

  APP_URL: string;
  GRAPH_VERSION: string;
  GRAPH_BASE?: string; // 只用于本地测试
  FAKE_TRANSCRIPT?: string; // 只用于本地测试：语音转文字直接返回这段字

  // 公开 Demo 站（另外部署一个 worker，用 wrangler.demo.jsonc）才有这些
  DEMO_SITE?: string; // "1" = 这是公开 Demo 站：没有登入页，只有示范资料，全部只读
  DEMO_DAILY_CAP?: string; // Demo 每天最多几次 AI 回复（默认 100）
  DEMO_DEEPSEEK_KEY?: string; // Demo 专用的 DeepSeek key（secret）
  DEMO_LLM_BASE_URL?: string; // 只用于本地测试
  REPO_URL?: string; // GitHub 链接，显示在 Demo 横幅

  // secrets
  META_APP_SECRET: string;
  META_VERIFY_TOKEN: string;
  ENCRYPTION_KEY: string;
  SETUP_KEY: string;
  META_APP_ID?: string; // 可选：用来识别自己 app 发出的 echo
}

/** 放进队列的工作。webhook 只负责拆成这些，然后马上回 200。 */
export type InboundJob =
  | {
      kind: 'message';
      pageId: string;
      psid: string;
      mid: string;
      text: string;
      timestamp: number;
      attachment?: { type: string; url?: string; transcript?: boolean; ms?: number }; // 顾客发的图片、语音等（url 是 Meta 的临时网址）
    }
  | {
      kind: 'echo';
      pageId: string;
      psid: string; // echo 的 recipient = 顾客
      mid: string;
      text: string;
      appId?: string;
      timestamp: number;
    };

export interface SessionUser {
  id: string;
  workspaceId: string;
  email: string;
  name: string;
  role: 'owner' | 'agent';
  demo: boolean; // 公开 Demo 账号：只能看 + 用模拟顾客聊天
}

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };
