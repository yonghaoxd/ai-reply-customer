// 密码、加密、签名。全部用 WebCrypto（原生实现，CPU 占用低）。

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 密码 ----------
// 免费版每次请求只有 10ms CPU，所以迭代次数比一般建议低。
// 次数存在每个用户的记录里；以后升级付费版可以调高，旧用户下次登入时自动升级。
export const PASSWORD_ITERATIONS = 20_000;

export async function hashPassword(password: string, saltB64?: string, iterations = PASSWORD_ITERATIONS) {
  const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return { hash: toB64(bits), salt: toB64(salt), iterations };
}

export async function verifyPassword(password: string, hashB64: string, saltB64: string, iterations: number) {
  const { hash } = await hashPassword(password, saltB64, iterations);
  return timingSafeEqual(hash, hashB64);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export function randomToken(bytes = 32): string {
  return toB64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!);
}

// ---------- 加密（Page token、API key）----------
async function aesKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('ENCRYPTION_KEY 没有设定');
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plain: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(plain));
  return toB64(iv) + '.' + toB64(ct);
}

export async function decryptSecret(blob: string | null | undefined, secret: string): Promise<string | null> {
  if (!blob) return null;
  const [ivB64, ctB64] = blob.split('.');
  if (!ivB64 || !ctB64) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(ivB64) }, await aesKey(secret), fromB64(ctB64));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

// ---------- Meta webhook 签名 ----------
export async function verifyMetaSignature(body: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header || !appSecret) return false;
  const [algo, sig] = header.split('=');
  if (algo !== 'sha256' || !sig) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = toHex(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return timingSafeEqual(mac, sig.toLowerCase());
}
