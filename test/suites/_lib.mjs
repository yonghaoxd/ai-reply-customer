// 测试共用的小工具
export function client(base) {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'X-Requested-With': 'mcs', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const t = await r.text();
    let j;
    try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, j, headers: r.headers };
  };
}
export const results = [];
export const check = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n} ${c ? '' : x}`);
export const done = () => { console.log(results.join('\n')); console.log(results.filter((x) => x.startsWith('FAIL')).length + ' failures'); };
export const mockLog = async () => (await fetch('http://localhost:9999/__log')).json();
export const mockClear = () => fetch('http://localhost:9999/__clear');
