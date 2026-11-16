// 你自己的站：登入保护、没有 Demo 入口、安全 headers
import { client, check, done } from './_lib.mjs';
const B = 'http://localhost:8787';
const own = client(B);
await own('POST', '/api/auth/setup', { setupKey: 'setup123', workspaceName: '测试店', name: 'Peko', email: 'peko@test.com', password: 'password123' });

let r = await own('GET', '/api/auth/status');
check('no demo on private site', r.j.demoSite === undefined && r.j.demoAvailable === undefined && r.j.user?.demo === false, JSON.stringify(r.j));
r = await own('POST', '/api/auth/demo'); check('/auth/demo is 404', r.status === 404);
r = await own('GET', '/api/demo'); check('old demo admin route gone', r.status === 404);
r = await own('GET', '/api/conversations'); check('secure headers on API', r.headers.get('x-frame-options') === 'SAMEORIGIN' && r.headers.get('x-content-type-options') === 'nosniff', JSON.stringify([...r.headers]));

// CSRF: write without the custom header is rejected
r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
check('login without X-Requested-With → 400', r.status === 400);

// email lockout: 5 wrong → locked, even with the right password
const anon = client(B);
for (let i = 0; i < 5; i++) r = await anon('POST', '/api/auth/login', { email: 'peko@test.com', password: 'wrong' + i });
check('5th wrong password still 401', r.status === 401);
r = await anon('POST', '/api/auth/login', { email: 'peko@test.com', password: 'password123' });
check('locked after 5 failures (right password refused)', r.status === 429 && /分钟/.test(r.j.message), JSON.stringify(r.j));
r = await anon('POST', '/api/auth/login', { email: 'PEKO@test.com ', password: 'password123' });
check('lock is case-insensitive', r.status === 429);
r = await own('GET', '/api/conversations'); check('existing session unaffected', r.status === 200);

// a different email is not locked by peko's failures; success clears its counter
await own('POST', '/api/users', { name: 'Amy', email: 'amy@test.com', password: 'password456', role: 'agent' });
const amy = client(B);
for (let i = 0; i < 3; i++) await amy('POST', '/api/auth/login', { email: 'amy@test.com', password: 'bad' });
r = await amy('POST', '/api/auth/login', { email: 'amy@test.com', password: 'password456' });
check('other account can log in', r.status === 200);
for (let i = 0; i < 4; i++) r = await amy('POST', '/api/auth/login', { email: 'amy@test.com', password: 'bad' });
check('success reset the counter (4 more → not locked)', r.status === 401, r.status);

// IP lockout: 20 failures from one IP across many emails
const spray = client(B);
for (let i = 0; i < 12; i++) r = await spray('POST', '/api/auth/login', { email: `x${i}@test.com`, password: 'nope' });
check('IP locked after 20 failures in total', r.status === 429, r.status);

// change-password is throttled too
done();
