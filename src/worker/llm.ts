// DeepSeek（OpenAI 兼容）chat completions，含 tool calling。

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export class LlmError extends Error {}

export interface LlmUsage {
  prompt: number;
  completion: number;
}

export async function chatCompletion(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  onUsage?: (u: LlmUsage) => void;
}): Promise<ChatMessage> {
  const url = opts.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 800,
  };
  if (opts.tools?.length) body.tools = opts.tools;

  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = (await res.json()) as { choices?: { message: ChatMessage }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      if (opts.onUsage) opts.onUsage({ prompt: data.usage?.prompt_tokens ?? 0, completion: data.usage?.completion_tokens ?? 0 });
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new LlmError('LLM 没有返回内容');
      return msg;
    }
    lastErr = `LLM ${res.status}: ${(await res.text()).slice(0, 300)}`;
    if (res.status < 500 && res.status !== 429) break; // 4xx（key 错等）不重试
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new LlmError(lastErr);
}
