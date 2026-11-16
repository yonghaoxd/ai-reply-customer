// 知识库：拆段、向量（Workers AI bge-m3）、检索。
// 免费版没有 Vectorize，所以向量存在 D1，检索时在 Worker 里算相似度。
// 向量生成失败时，用关键词（中文按两个字一组）检索兜底。
import type { Env } from './env';
import { newId, now } from './util';

const EMBED_MODEL = '@cf/baai/bge-m3';
const EMBED_BATCH = 32;
export const MAX_DOC_CHARS = 300_000;
const SMALL_KB_CHARS = 3_000;

// ---------- 拆段 ----------
export function chunkText(text: string, size = 500, overlap = 80): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = '';
  };
  for (const p of paras) {
    if (p.length > size) {
      push();
      for (let i = 0; i < p.length; i += size - overlap) chunks.push(p.slice(i, i + size).trim());
      continue;
    }
    if ((cur + '\n\n' + p).length > size) {
      const tail = cur.slice(-overlap);
      push();
      cur = tail ? tail + '\n' + p : p;
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
  }
  push();
  return chunks.filter((c) => c.length > 5);
}

// ---------- 向量 ----------
export async function embed(env: Env, texts: string[]): Promise<(Float32Array | null)[]> {
  const out: (Float32Array | null)[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    try {
      const res = (await env.AI.run(EMBED_MODEL as any, { text: batch } as any)) as { data?: number[][] };
      const data = res?.data ?? [];
      for (let j = 0; j < batch.length; j++) out.push(data[j] ? normalize(Float32Array.from(data[j])) : null);
    } catch (e) {
      console.warn('embed failed', (e as Error).message);
      for (let j = 0; j < batch.length; j++) out.push(null);
    }
  }
  return out;
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function toFloat32(blob: unknown): Float32Array | null {
  if (!blob) return null;
  if (blob instanceof ArrayBuffer) return new Float32Array(blob);
  if (ArrayBuffer.isView(blob)) {
    const b = blob as Uint8Array;
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }
  if (Array.isArray(blob)) return new Float32Array(Uint8Array.from(blob as number[]).buffer);
  return null;
}

/** 把一份资料拆段、生成向量、存进 D1（会先删除旧的段）。 */
export async function indexDocument(env: Env, workspaceId: string, documentId: string, content: string) {
  const chunks = chunkText(content);
  const vectors = await embed(env, chunks);
  const stmts: D1PreparedStatement[] = [env.DB.prepare('DELETE FROM kb_chunks WHERE document_id = ?').bind(documentId)];
  chunks.forEach((text, idx) => {
    const v = vectors[idx];
    stmts.push(
      env.DB.prepare('INSERT INTO kb_chunks (id, workspace_id, document_id, idx, text, embedding) VALUES (?, ?, ?, ?, ?, ?)').bind(
        newId('k_'),
        workspaceId,
        documentId,
        idx,
        text,
        v ? v.buffer : null,
      ),
    );
  });
  const missing = vectors.filter((v) => !v).length;
  stmts.push(
    env.DB.prepare('UPDATE kb_documents SET chunk_count = ?, status = ?, error = ?, updated_at = ? WHERE id = ?').bind(
      chunks.length,
      'ready',
      missing ? `${missing} 段没有生成向量，暂时用关键词检索` : null,
      now(),
      documentId,
    ),
  );
  // D1 batch 一次最多 100 条左右比较稳，分批写
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { chunks: chunks.length, missingVectors: missing };
}

// ---------- 检索 ----------
function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ');
  const set = new Set<string>();
  for (const w of t.split(' ')) {
    if (!w) continue;
    if (/^[a-z0-9]+$/.test(w)) {
      if (w.length > 1) set.add(w);
    } else {
      for (let i = 0; i < w.length - 1; i++) set.add(w.slice(i, i + 2));
      if (w.length === 1) set.add(w);
    }
  }
  return set;
}

function keywordScore(q: Set<string>, text: string): number {
  if (!q.size) return 0;
  const t = bigrams(text);
  let hit = 0;
  for (const g of q) if (t.has(g)) hit++;
  return hit / q.size;
}

export interface KbHit {
  text: string;
  score: number;
  title: string;
}

export async function searchKb(env: Env, workspaceId: string, query: string, k = 4): Promise<KbHit[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.text, c.embedding, d.title FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
     WHERE c.workspace_id = ? AND d.enabled = 1`,
  )
    .bind(workspaceId)
    .all<{ text: string; embedding: unknown; title: string }>();
  if (!results.length) return [];

  const anyVector = results.some((r) => r.embedding);
  const [qv] = anyVector ? await embed(env, [query]) : [null];
  const qg = bigrams(query);

  const scored = results.map((r) => {
    const v = qv ? toFloat32(r.embedding) : null;
    let score: number;
    if (qv && v && v.length === qv.length) {
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * qv[i];
      score = dot;
    } else {
      score = keywordScore(qg, r.text) * 0.8; // 关键词分数稍微打折
    }
    return { text: r.text, title: r.title, score };
  });
  scored.sort((a, b) => b.score - a.score);
  // 知识库很小时（例如只有几段常见问题），全部给 AI 最稳，不怕检索漏掉
  const totalChars = results.reduce((n, r) => n + r.text.length, 0);
  if (totalChars <= SMALL_KB_CHARS) return scored;
  return scored.filter((s) => s.score >= 0.3).slice(0, k);
}
