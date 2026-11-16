// 忘记后台密码时用。
//   查看有哪些账号：   node reset-password.mjs
//   重设某个账号密码： node reset-password.mjs 你的email 新密码
// 会直接修改 Cloudflare 上的数据库，并让这个账号所有已登入的装置登出。
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ITERATIONS = 20000; // 要跟 src/worker/crypto.ts 的 PASSWORD_ITERATIONS 一样
const [email, password] = process.argv.slice(2);
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function runSql(sql) {
  const file = '.reset-password.sql';
  writeFileSync(file, sql);
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--remote', '--file', file, '--yes'], { stdio: 'inherit', shell: true });
  unlinkSync(file);
  return r.status === 0;
}

if (!email) {
  console.log('\n后台账号：');
  runSql('SELECT email, name, role FROM users;');
  console.log('\n要重设密码：node reset-password.mjs 你的email 新密码\n');
  process.exit(0);
}
if (!password || password.length < 8) {
  console.error('新密码至少 8 个字');
  process.exit(1);
}
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const ok = runSql(
  `UPDATE users SET password_hash = ${q(hash.toString('base64'))}, password_salt = ${q(salt.toString('base64'))}, password_iter = ${ITERATIONS} WHERE email = ${q(email.trim().toLowerCase())};\n` +
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${q(email.trim().toLowerCase())});\n` +
    `SELECT email, name FROM users WHERE email = ${q(email.trim().toLowerCase())};`,
);
console.log(ok ? '\n如果上面的表格显示了你的 email，密码就改好了，可以用新密码登入。表格是空的就代表 email 打错了。' : '\n执行失败，请把上面的错误截图。');
