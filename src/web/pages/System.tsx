import { useEffect, useState } from 'react';
import { api, del, post, put } from '../api';
import { useI18n } from '../i18n';
import type { BotSettings } from '../../shared/settings';
import type { Me } from '../App';

interface Sys {
  page: { page_id: string; name: string } | null;
  hasDeepseekKey: boolean;
  hasTelegramToken: boolean;
  webhookUrl: string;
  privacyUrl: string;
  verifyTokenSet: boolean;
  appSecretSet: boolean;
  appIdSet: boolean;
  appUrl: string;
  hasMediaStore: boolean;
}

function useFlash() {
  const [m, setM] = useState<{ ok: boolean; text: string } | null>(null);
  const flash = (ok: boolean, text: string) => {
    setM({ ok, text });
    setTimeout(() => setM(null), 4000);
  };
  const view = m ? <div className={m.ok ? 'ok' : 'error'} style={{ marginTop: 8 }}>{m.text}</div> : null;
  return [flash, view] as const;
}

export function SystemPage({ me }: { me: Me }) {
  const { t } = useI18n();
  const [sys, setSys] = useState<Sys | null>(null);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const isOwner = me.role === 'owner';
  const load = () => api<Sys>('/system').then(setSys);
  useEffect(() => {
    load();
    api<{ stats: Record<string, number> }>('/stats').then((r) => setStats(r.stats));
  }, []);
  if (!sys) return <div className="page">{t('loading')}</div>;

  return (
    <div className="page">
      <div className="page-head"><h1>{t('navSystem')}</h1></div>

      {stats && (
        <>
          <h3>{t('stats7d')}</h3>
          <div className="stats">
            <div className="stat"><div className="n">{stats.inbound7d}</div><div className="l">{t('statInbound')}</div></div>
            <div className="stat"><div className="n">{stats.bot7d}</div><div className="l">{t('statBot')}</div></div>
            <div className="stat"><div className="n">{stats.handoffs7d}</div><div className="l">{t('statHandoffs')}</div></div>
            <div className="stat"><div className="n">{stats.leads7d}</div><div className="l">{t('statLeads')}</div></div>
          </div>
        </>
      )}

      <div className="card">
        <h2>{t('checks')}</h2>
        <div className="kv"><b>META_APP_SECRET</b>{sys.appSecretSet ? '✅' : '❌'}</div>
        <div className="kv"><b>META_VERIFY_TOKEN</b>{sys.verifyTokenSet ? '✅' : '❌'}</div>
        <div className="kv"><b>META_APP_ID</b>{sys.appIdSet ? '✅' : '⚠️'}</div>
        <div className="kv"><b>DeepSeek</b>{sys.hasDeepseekKey ? '✅' : '❌'}</div>
        <div className="kv"><b>{t('fbPage')}</b>{sys.page ? '✅' : '❌'}</div>
        <div className="kv"><b>APP_URL</b>{sys.appUrl === window.location.origin ? '✅' : '❌'} {sys.appUrl}</div>
        <div className="kv"><b>KV (MEDIA)</b>{sys.hasMediaStore ? '✅' : '❌'}</div>
        {sys.appUrl !== window.location.origin && (
          <div className="error">wrangler.jsonc 的 APP_URL 应该是 {window.location.origin}。不对的话，图片发不出去、Telegram 链接也会错。改好后重新 npm run deploy。</div>
        )}
        <label className="field" style={{ marginTop: 12 }}><span>{t('webhookUrl')}</span><code className="copy">{sys.webhookUrl}</code></label>
        <label className="field"><span>{t('privacyUrl')}</span><code className="copy"><a href="/privacy" target="_blank">{sys.privacyUrl}</a></code></label>
      </div>

      <fieldset disabled={!isOwner} style={{ border: 0, padding: 0, margin: 0 }}>
        <PageCard sys={sys} reload={load} />
        <SecretCard title={t('deepseekKey')} isSet={sys.hasDeepseekKey} path="/system/deepseek" field="apiKey" reload={load} />
        <TelegramCard sys={sys} reload={load} />
      </fieldset>
      <TeamCard me={me} />
    </div>
  );
}

function PageCard({ sys, reload }: { sys: Sys; reload: () => void }) {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, view] = useFlash();
  return (
    <div className="card">
      <h2>{t('fbPage')}</h2>
      <p>{sys.page ? t('connectedTo', { name: sys.page.name, id: sys.page.page_id }) : <span className="badge danger">{t('notConnected')}</span>}</p>
      <label className="field"><span>{t('pageToken')}</span><input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAAG…" /></label>
      <button
        className="primary"
        disabled={busy || !token.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await put<{ page: { name: string } }>('/system/page', { pageToken: token });
            setToken('');
            flash(true, `✅ ${r.page.name}`);
            reload();
          } catch (e) {
            flash(false, (e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('connect')}
      </button>
      {view}
    </div>
  );
}

function SecretCard({ title, isSet, path, field, reload }: { title: string; isSet: boolean; path: string; field: string; reload: () => void }) {
  const { t } = useI18n();
  const [v, setV] = useState('');
  const [flash, view] = useFlash();
  return (
    <div className="card">
      <h2>{title}</h2>
      <p className="hint">{isSet ? t('keySet') : t('keyNotSet')}</p>
      <div className="row">
        <input className="grow" type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder="sk-…" />
        <button
          className="primary"
          disabled={!v.trim()}
          onClick={async () => {
            try {
              await put(path, { [field]: v });
              setV('');
              flash(true, t('saved'));
              reload();
            } catch (e) {
              flash(false, (e as Error).message);
            }
          }}
        >
          {t('save')}
        </button>
      </div>
      {view}
    </div>
  );
}

function TelegramCard({ sys, reload }: { sys: Sys; reload: () => void }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<BotSettings | null>(null);
  const [token, setToken] = useState('');
  const [chats, setChats] = useState<{ id: string; name: string }[]>([]);
  const [flash, view] = useFlash();
  useEffect(() => {
    api<{ settings: BotSettings }>('/settings').then((r) => setSettings(r.settings));
  }, []);
  if (!settings) return null;

  const saveSettings = async (patchS: Partial<BotSettings>) => {
    const next = { ...settings, ...patchS };
    setSettings(next);
    await put('/settings', next);
  };

  return (
    <div className="card">
      <h2>{t('telegram')}</h2>
      <label className="check"><input type="checkbox" checked={settings.telegramEnabled} onChange={(e) => saveSettings({ telegramEnabled: e.target.checked })} /> {t('enabled')}</label>
      <label className="field">
        <span>{t('telegramToken')} — {sys.hasTelegramToken ? t('keySet') : t('keyNotSet')}</span>
        <div className="row">
          <input className="grow" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456:ABC…" />
          <button disabled={!token.trim()} onClick={async () => { try { await put('/system/telegram', { token }); setToken(''); flash(true, t('saved')); reload(); } catch (e) { flash(false, (e as Error).message); } }}>{t('save')}</button>
        </div>
      </label>
      <label className="field">
        <span>{t('chatId')}</span>
        <div className="row">
          <input className="grow" value={settings.telegramChatId} onChange={(e) => setSettings({ ...settings, telegramChatId: e.target.value })} onBlur={() => saveSettings({})} />
          <button onClick={async () => { try { const r = await post<{ chats: { id: string; name: string }[] }>('/system/telegram/find-chat'); setChats(r.chats); if (!r.chats.length) flash(false, t('findChatHint')); } catch (e) { flash(false, (e as Error).message); } }}>{t('findChat')}</button>
        </div>
      </label>
      <p className="hint">{t('findChatHint')}</p>
      {chats.map((c) => (
        <button key={c.id} className="small" style={{ marginRight: 6 }} onClick={() => saveSettings({ telegramChatId: c.id })}>{c.name || c.id} ({c.id})</button>
      ))}
      <div style={{ marginTop: 10 }}>
        <button onClick={async () => { try { await post('/system/telegram/test'); flash(true, '✅'); } catch (e) { flash(false, (e as Error).message); } }}>{t('sendTest')}</button>
      </div>
      {view}
    </div>
  );
}

function TeamCard({ me }: { me: Me }) {
  const { t } = useI18n();
  const [users, setUsers] = useState<{ id: string; email: string; name: string; role: string }[]>([]);
  const [draft, setDraft] = useState({ name: '', email: '', password: '', role: 'agent' });
  const [pw, setPw] = useState({ current: '', next: '' });
  const [flash, view] = useFlash();
  const load = () => api<{ users: typeof users }>('/users').then((r) => setUsers(r.users));
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="card">
      <h2>{t('team')}</h2>
      <table className="list" style={{ marginBottom: 14 }}>
        <thead><tr><th>{t('name')}</th><th>{t('email')}</th><th>{t('role')}</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td><td>{u.email}</td><td>{t(u.role === 'owner' ? 'role_owner' : 'role_agent')}</td>
              <td>{me.role === 'owner' && u.id !== me.id && <button className="small danger" onClick={async () => { if (confirm(t('confirmDelete'))) { await del(`/users/${u.id}`); load(); } }}>{t('delete')}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {me.role === 'owner' && (
        <>
          <h3>{t('addUser')}</h3>
          <div className="grid2">
            <label className="field"><span>{t('name')}</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label className="field"><span>{t('email')}</span><input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></label>
            <label className="field"><span>{t('newPassword')}</span><input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} /></label>
            <label className="field">
              <span>{t('role')}</span>
              <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
                <option value="agent">{t('role_agent')}</option>
                <option value="owner">{t('role_owner')}</option>
              </select>
            </label>
          </div>
          <button onClick={async () => { try { await post('/users', draft); setDraft({ name: '', email: '', password: '', role: 'agent' }); load(); flash(true, t('saved')); } catch (e) { flash(false, (e as Error).message); } }}>{t('add')}</button>
        </>
      )}
      <h3 style={{ marginTop: 20 }}>{t('changePassword')}</h3>
      <div className="grid2">
        <label className="field"><span>{t('currentPassword')}</span><input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
        <label className="field"><span>{t('newPassword')}</span><input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></label>
      </div>
      <button onClick={async () => { try { await post('/users/me/password', pw); setPw({ current: '', next: '' }); flash(true, t('saved')); } catch (e) { flash(false, (e as Error).message); } }}>{t('changePassword')}</button>
      {view}
    </div>
  );
}
