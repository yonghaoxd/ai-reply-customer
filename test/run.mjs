// 本地端到端测试：用假的 Meta + DeepSeek（test/mock-server.mjs），每个测试档用一个全新的本地数据库。
//   npm test                 跑全部
//   npm test -- 05 07        只跑档名包含 05 或 07 的
// 你自己的站的测试跑在 :8787；公开 Demo 站（wrangler.demo.jsonc）的测试跑在 :8788。
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const filter = process.argv.slice(2);
const suites = readdirSync(join(ROOT, 'test/suites')).filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && (!filter.length || filter.some((x) => f.includes(x)))).sort();
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 测试用的值（不是真的机密）
const PRIVATE_VARS = {
  META_APP_SECRET: 'testsecret',
  META_VERIFY_TOKEN: 'verify123',
  ENCRYPTION_KEY: 'test-only-encryption-key-0123456789abcdef',
  SETUP_KEY: 'setup123',
  GRAPH_BASE: 'http://localhost:9999',
  FAKE_TRANSCRIPT: '我想问课程多少钱',
  APP_URL: 'http://localhost:8787',
};
const DEMO_VARS = { DEMO_DEEPSEEK_KEY: 'sk-test', DEMO_LLM_BASE_URL: 'http://localhost:9999', DEMO_DAILY_CAP: '5', APP_URL: 'http://localhost:8788' };

async function waitFor(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('server did not start: ' + url);
}

function startWorker(config, port, vars, persist) {
  const args = ['wrangler', 'dev', '--local', '-c', config, '--port', String(port), '--persist-to', persist, '--test-scheduled', '--show-interactive-dev-session=false'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  return spawn(npx, args, { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32', detached: process.platform !== 'win32' });
}

function kill(p) {
  if (!p) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F']);
  else {
    try {
      process.kill(-p.pid, 'SIGTERM'); // 整组一起关（npx → wrangler → workerd）
    } catch {}
  }
}

async function waitClosed(port) {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://localhost:${port}/`);
    } catch {
      return;
    }
    await sleep(250);
  }
}

if (!existsSync(join(ROOT, 'wrangler.jsonc'))) {
  console.error('需要 wrangler.jsonc（复制 wrangler.example.jsonc 就可以，本地测试不用真的 id）');
  process.exit(1);
}

console.log('building dashboard…');
execFileSync(npx, ['vite', 'build', '--logLevel', 'error'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });

for (const port of [8787, 8788, 9999]) {
  try {
    await fetch(`http://localhost:${port}/`);
    console.error(`port ${port} is already in use — stop the other dev server first`);
    process.exit(1);
  } catch {}
}
const mock = spawn(process.execPath, [join(ROOT, 'test/mock-server.mjs')], { stdio: 'ignore' });
await waitFor('http://localhost:9999/__log');

let failures = 0;
let passes = 0;
for (const file of suites) {
  const demo = file.includes('demo-site');
  const config = demo ? 'wrangler.demo.jsonc' : 'wrangler.jsonc';
  const port = demo ? 8788 : 8787;
  const persist = join(ROOT, '.wrangler/test', file.replace(/\.mjs$/, ''));
  rmSync(persist, { recursive: true, force: true });
  execFileSync(npx, ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '-c', config, '--persist-to', persist], { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32' });
  const worker = startWorker(config, port, demo ? DEMO_VARS : PRIVATE_VARS, persist);
  try {
    await waitFor(`http://localhost:${port}/api/auth/status`);
    await fetch('http://localhost:9999/__clear');
    process.stdout.write(`\n▶ ${file}\n`);
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [join(ROOT, 'test/suites', file)], { cwd: ROOT, env: { ...process.env, TEST_PERSIST: persist, TEST_CONFIG: config } });
      let buf = '';
      p.stdout.on('data', (d) => (buf += d));
      p.stderr.on('data', (d) => (buf += d));
      p.on('close', (code) => resolve({ buf, code }));
    });
    const lines = out.buf.split('\n').filter((l) => /^(PASS|FAIL)/.test(l));
    const f = lines.filter((l) => l.startsWith('FAIL'));
    passes += lines.length - f.length;
    failures += f.length + (out.code ? 1 : 0);
    console.log(`  ${lines.length - f.length} passed, ${f.length} failed`);
    for (const l of f) console.log('  ' + l);
    if (out.code) console.log(out.buf.split('\n').slice(-15).join('\n'));
  } finally {
    kill(worker);
    await waitClosed(port);
  }
}
mock.kill();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
