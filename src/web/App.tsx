import { useEffect, useState, type FormEvent } from 'react';
import { api, post } from './api';
import { useI18n } from './i18n';
import { Inbox } from './pages/Inbox';
import { Customers } from './pages/Customers';
import { Leads } from './pages/Leads';
import { Products } from './pages/Products';
import { SopPage } from './pages/Sop';
import { Simulator } from './pages/Simulator';
import { Knowledge } from './pages/Knowledge';
import { BotSettingsPage } from './pages/BotSettings';
import { SystemPage } from './pages/System';
import { Reports } from './pages/Reports';
import { EvalPage } from './pages/Eval';

export interface Me {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'agent';
  demo?: boolean;
}

/** 简单的 hash 路由：#/inbox/xxx */
export function useRoute(): [string[], (path: string) => void] {
  const parse = () => (window.location.hash.replace(/^#\/?/, '') || 'inbox').split('/');
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (p: string) => (window.location.hash = '/' + p)];
}

export function App() {
  const [state, setState] = useState<{ loading: boolean; needsSetup: boolean; user: Me | null; demoSite?: boolean; repoUrl?: string | null; error?: string }>({
    loading: true,
    needsSetup: false,
    user: null,
  });
  const load = (): Promise<void> =>
    api<{ needsSetup: boolean; user: Me | null; demoSite?: boolean; repoUrl?: string | null }>('/auth/status')
      .then(async (r): Promise<void> => {
        // 公开 Demo 站：没有登入页，访客自动进示范账号
        if (r.demoSite && !r.user) {
          try {
            await post('/auth/demo');
          } catch (e) {
            return setState({ loading: false, needsSetup: false, user: null, demoSite: true, error: (e as Error).message });
          }
          return load();
        }
        setState({ loading: false, ...r });
      })
      .catch((e) => setState({ loading: false, needsSetup: false, user: null, error: (e as Error).message }));
  useEffect(() => {
    load();
    const on = () => setState((s) => ({ ...s, user: null }));
    window.addEventListener('mcs:unauthorized', on);
    return () => window.removeEventListener('mcs:unauthorized', on);
  }, []);

  if (state.loading) return null;
  if (state.demoSite && !state.user) {
    return (
      <div className="auth-wrap">
        <div className="card auth-card">{state.error ? <div className="error">{state.error}</div> : null}<button onClick={() => { setState({ ...state, loading: true }); load(); }}>Retry</button></div>
      </div>
    );
  }
  if (state.needsSetup) return <Setup onDone={load} />;
  if (!state.user) return <Login onDone={load} />;
  return <Shell me={state.user} onLogout={load} repoUrl={state.repoUrl ?? null} />;
}

function LangToggle() {
  const { lang, setLang } = useI18n();
  return (
    <div className="lang-toggle">
      <button className={'small' + (lang === 'zh' ? ' on' : '')} onClick={() => setLang('zh')}>中文</button>
      <button className={'small' + (lang === 'en' ? ' on' : '')} onClick={() => setLang('en')}>EN</button>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await post('/auth/login', { email, password });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
          <h1>{t('appName')}</h1>
          <LangToggle />
        </div>
        <label className="field"><span>{t('email')}</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
        <label className="field"><span>{t('password')}</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {err && <div className="error">{err}</div>}
        <button className="primary" style={{ width: '100%' }} disabled={busy}>{t('login')}</button>
      </form>
    </div>
  );
}

function Setup({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ setupKey: '', workspaceName: 'Ai教育掌握未来', name: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await post('/auth/setup', f);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>{t('setupTitle')}</h2>
          <LangToggle />
        </div>
        <label className="field"><span>{t('setupKey')}</span><input value={f.setupKey} onChange={set('setupKey')} required /></label>
        <label className="field"><span>{t('businessName')}</span><input value={f.workspaceName} onChange={set('workspaceName')} required /></label>
        <label className="field"><span>{t('name')}</span><input value={f.name} onChange={set('name')} required /></label>
        <label className="field"><span>{t('email')}</span><input type="email" value={f.email} onChange={set('email')} required /></label>
        <label className="field"><span>{t('newPassword')}</span><input type="password" minLength={8} value={f.password} onChange={set('password')} required /></label>
        {err && <div className="error">{err}</div>}
        <button className="primary" style={{ width: '100%' }} disabled={busy}>{t('createAccount')}</button>
      </form>
    </div>
  );
}

function Shell({ me, onLogout, repoUrl }: { me: Me; onLogout: () => void; repoUrl: string | null }) {
  const { t } = useI18n();
  const [route, go] = useRoute();
  const [counts, setCounts] = useState({ unread: 0, human: 0 });

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api<{ counts: { unread: number; human: number } }>('/conversations?filter=unread')
        .then((r) => alive && setCounts(r.counts))
        .catch(() => {});
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const n = counts.unread + counts.human;
    document.title = (n ? `(${n}) ` : '') + t('appName');
  }, [counts, t]);

  const nav: [string, ReturnType<typeof t>, number?][] = [
    ['inbox', t('navInbox'), counts.unread + counts.human],
    ['sim', t('navSim')],
    ['customers', t('navCustomers')],
    ['leads', t('navLeads')],
    ['reports', t('navReports')],
    ['products', t('navProducts')],
    ['sop', t('navSop')],
    ['kb', t('navKb')],
    ['eval', t('navEval')],
    ['bot', t('navBot')],
    ['system', t('navSystem')],
  ];
  const page = route[0];
  const logout = async () => {
    await post('/auth/logout').catch(() => {});
    onLogout();
  };

  return (
    <div className={'shell' + (me.demo ? ' demo' : '')}>
      {me.demo && (
        <div className="demo-banner">
          {t('demoBanner')}
          {repoUrl && <> · <a href={repoUrl} target="_blank" rel="noreferrer">{t('sourceCode')}</a></>}
        </div>
      )}
      <nav className="sidebar">
        <div className="brand">{t('appName')}</div>
        {nav.map(([key, label, n]) => (
          <a key={key} href={'#/' + key} className={page === key ? 'active' : ''}>
            {label}
            {!!n && <span className="count">{n}</span>}
          </a>
        ))}
        <div className="bottom">
          <div>{me.name} · {t(me.demo ? 'role_demo' : me.role === 'owner' ? 'role_owner' : 'role_agent')}</div>
          <LangToggle />
          {!me.demo && <button className="small" onClick={logout}>{t('logout')}</button>}
        </div>
      </nav>
      <main className="main">
        {page === 'inbox' && <Inbox selectedId={route[1]} go={go} />}
        {page === 'sim' && <Simulator selectedId={route[1]} go={go} demo={!!me.demo} />}
        {page === 'customers' && <Customers go={go} />}
        {page === 'leads' && <Leads go={go} />}
        {page === 'reports' && <Reports />}
        {page === 'eval' && <EvalPage me={me} />}
        {page === 'products' && <Products />}
        {page === 'sop' && <SopPage me={me} />}
        {page === 'kb' && <Knowledge />}
        {page === 'bot' && <BotSettingsPage me={me} />}
        {page === 'system' && <SystemPage me={me} />}
      </main>
    </div>
  );
}
