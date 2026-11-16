// Bot 设定（后台「Bot 设定」页面可调）。前后端共用。

export type Tone = 'friendly' | 'professional' | 'concise';
export type EmojiLevel = 'none' | 'sometimes' | 'often';

export interface BotSettings {
  businessName: string;
  botName: string;
  botIdentity: string;          // bot 的身份介绍
  tone: Tone;
  toneExtra: string;            // 自由补充的语气说明
  emoji: EmojiLevel;
  maxSentences: number;         // 回复长度上限（句）
  forbiddenTopics: string[];    // 禁区：AI 不能谈的事（写进 prompt）
  forbiddenKeywords: string[];  // 顾客信息含这些词 → 直接转真人
  handoffKeywords: string[];    // 顾客要求真人的关键词
  handoffReply: string;         // 转真人时发给顾客的固定回复
  greetingEnabled: boolean;
  greeting: string;             // 开场白（第一次聊天时发）
  unknownReply: string;         // 查不到答案时的说法（AI 参考）
  collectLeads: boolean;
  autoResumeEnabled: boolean;   // 接管后自动交还 bot
  autoResumeHours: number;
  historyLimit: number;         // 短期记忆：带最近几条对话
  rateLimitPerMinute: number;   // 每个顾客每分钟最多几次 AI 回复
  model: string;                // DeepSeek 模型名
  llmBaseUrl: string;           // OpenAI 兼容接口地址
  telegramChatId: string;
  telegramEnabled: boolean;
  retentionDays: number;        // 对话保存天数（0 = 不自动删除）
  botEnabled: boolean;          // 总开关
  voiceEnabled: boolean;        // 顾客发语音时转成文字再回答
  voiceFailReply: string;       // 听不了语音时的回复
  followUpEnabled: boolean;     // 顾客没回复时自动跟进
  followUpCount: number;        // 最多跟进几次（1 或 2）
  followUpMinutes1: number;     // 顾客最后一句话之后几分钟，第一次跟进
  followUpMinutes2: number;     // 第二次跟进（要在 24 小时窗口内）
  followUpText: string;         // 第一次跟进的默认话术（SOP 步骤可以各自覆盖）
  followUpText2: string;        // 第二次（最后一次）跟进的话术
}

export const DEFAULT_SETTINGS: BotSettings = {
  businessName: 'Ai教育掌握未来',
  botName: '小助手',
  botIdentity: 'Ai教育掌握未来的自动客服，帮忙介绍 AI 课程、回答常见问题、帮顾客报名。',
  tone: 'friendly',
  toneExtra: '',
  emoji: 'sometimes',
  maxSentences: 4,
  forbiddenTopics: ['保证赚钱或保证效果', '自行给折扣或优惠', '政治和宗教', '评论竞争对手'],
  forbiddenKeywords: ['退款', 'refund', '投诉', '律师', '骗子'],
  handoffKeywords: ['真人', '客服', '人工', 'human', 'agent', 'admin'],
  handoffReply: '好的，我已经通知同事，他们会尽快在这里回复你 🙏',
  greetingEnabled: true,
  greeting: '你好！我是 Ai教育掌握未来的自动小助手 🤖 有什么关于课程的问题都可以问我；想找真人，随时打「真人」。',
  unknownReply: '这个我不太确定，我帮你转给同事确认，好吗？',
  collectLeads: true,
  autoResumeEnabled: true,
  autoResumeHours: 12,
  historyLimit: 20,
  rateLimitPerMinute: 5,
  model: 'deepseek-v4-flash',
  llmBaseUrl: 'https://api.deepseek.com',
  telegramChatId: '',
  telegramEnabled: false,
  retentionDays: 365,
  botEnabled: true,
  voiceEnabled: true,
  voiceFailReply: '抱歉，这段语音我听不清楚，可以打字告诉我吗？🙏',
  followUpEnabled: false,
  followUpCount: 1,
  followUpMinutes1: 180,
  followUpMinutes2: 1200,
  followUpText: '你好，刚才的资料有看到吗？还有什么想了解的，可以直接问我 😊',
  followUpText2: '如果之后还有兴趣或有任何问题，随时在这里留言给我们。祝你有美好的一天！',
};

export function mergeSettings(raw: unknown): BotSettings {
  const s = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof BotSettings)[]) {
      const v = (raw as Record<string, unknown>)[key];
      const d = DEFAULT_SETTINGS[key];
      if (v === undefined || v === null) continue;
      if (Array.isArray(d)) {
        if (Array.isArray(v)) (s as Record<string, unknown>)[key] = v.map(String).map((x) => x.trim()).filter(Boolean);
      } else if (typeof d === typeof v) {
        (s as Record<string, unknown>)[key] = v;
      }
    }
  }
  s.maxSentences = clamp(s.maxSentences, 1, 12);
  s.autoResumeHours = clamp(s.autoResumeHours, 1, 168);
  s.historyLimit = clamp(s.historyLimit, 4, 50);
  s.rateLimitPerMinute = clamp(s.rateLimitPerMinute, 1, 30);
  s.retentionDays = clamp(s.retentionDays, 0, 3650);
  s.followUpCount = clamp(s.followUpCount, 1, 2);
  s.followUpMinutes1 = clamp(s.followUpMinutes1, 5, 1350);
  s.followUpMinutes2 = clamp(s.followUpMinutes2, s.followUpMinutes1 + 30, 1410);
  return s;
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
