// 语音转文字：用 Workers AI 的 Whisper。
// 失败（额度用完、档案太大、格式不支持）时返回 null，由调用方决定怎么回复顾客。
import type { Env } from './env';

const MODEL = '@cf/openai/whisper-large-v3-turbo';
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // 约 8 分钟的手机语音

function toBase64(bytes: Uint8Array): string {
  // 新版运行环境有原生的 toBase64，快很多（免费版 CPU 只有 10ms）
  const native = (bytes as unknown as { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export interface Transcript {
  text: string;
  ms: number;
}

export async function transcribeBytes(env: Env, buf: ArrayBuffer, hint = ''): Promise<Transcript | null> {
  if (!buf.byteLength || buf.byteLength > MAX_AUDIO_BYTES) return null;
  const started = Date.now();
  // 只用于本地测试：不呼叫 Workers AI，直接返回这段字
  if (env.FAKE_TRANSCRIPT) return { text: env.FAKE_TRANSCRIPT, ms: 0 };
  try {
    const input: Record<string, unknown> = { audio: toBase64(new Uint8Array(buf)) };
    // 把生意和产品名字告诉 Whisper，专有名词比较不会听错
    if (hint) input.initial_prompt = hint.slice(0, 400);
    const res = (await env.AI.run(MODEL as any, input as any)) as { text?: string };
    const text = (res?.text || '').trim();
    return text ? { text: text.slice(0, 2000), ms: Date.now() - started } : null;
  } catch (e) {
    console.warn('transcribe failed', (e as Error).message);
    return null;
  }
}

export async function transcribeUrl(env: Env, url: string, hint = ''): Promise<Transcript | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_AUDIO_BYTES) return null;
    return transcribeBytes(env, await res.arrayBuffer(), hint);
  } catch (e) {
    console.warn('audio download failed', (e as Error).message);
    return null;
  }
}
