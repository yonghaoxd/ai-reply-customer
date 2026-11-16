import { useEffect, useRef, useState } from 'react';
import { api, post, put, type Media } from '../api';
import { MediaThumb } from '../components/MediaThumb';
import { useI18n } from '../i18n';
import type { BotSettings } from '../../shared/settings';
import type { Me } from '../App';

const lines = (a: string[]) => a.join('\n');
const unlines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

export function BotSettingsPage({ me }: { me: Me }) {
  const { t } = useI18n();
  const [s, setS] = useState<BotSettings | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const isOwner = me.role === 'owner';

  useEffect(() => {
    api<{ settings: BotSettings }>('/settings').then((r) => setS(r.settings));
  }, []);
  if (!s) return <div className="page">{t('loading')}</div>;

  const set = <K extends keyof BotSettings>(k: K, v: BotSettings[K]) => setS({ ...s, [k]: v });
  const save = async () => {
    setErr('');
    try {
      const r = await put<{ settings: BotSettings }>('/settings', s);
      setS(r.settings);
      setMsg(t('saved'));
      setTimeout(() => setMsg(''), 2000);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const text = (k: keyof BotSettings, label: Parameters<typeof t>[0], multiline = false) => (
    <label className="field">
      <span>{t(label)}</span>
      {multiline ? (
        <textarea value={s[k] as string} onChange={(e) => set(k, e.target.value as never)} />
      ) : (
        <input value={s[k] as string} onChange={(e) => set(k, e.target.value as never)} />
      )}
    </label>
  );
  const list = (k: 'forbiddenTopics' | 'forbiddenKeywords' | 'handoffKeywords', label: Parameters<typeof t>[0]) => (
    <label className="field">
      <span>{t(label)}</span>
      <textarea defaultValue={lines(s[k])} onBlur={(e) => set(k, unlines(e.target.value))} />
    </label>
  );
  const num = (k: keyof BotSettings, label: Parameters<typeof t>[0]) => (
    <label className="field">
      <span>{t(label)}</span>
      <input type="number" value={s[k] as number} onChange={(e) => set(k, Number(e.target.value) as never)} />
    </label>
  );

  return (
    <div className="page" style={{ maxWidth: 1300 }}>
      <div className="page-head">
        <h1>{t('navBot')}</h1>
        <div className="row">
          {msg && <span className="ok">{msg}</span>}
          {isOwner && <button className="primary" onClick={save}>{t('save')}</button>}
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      {isOwner && <Templates onApplied={(next) => setS(next)} />}
      <div className="settings-layout">
        <fieldset disabled={!isOwner} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="card">
            <label className="check"><input type="checkbox" checked={s.botEnabled} onChange={(e) => set('botEnabled', e.target.checked)} /> <b>{t('botOn')}</b></label>
            <div className="grid2">
              {text('businessName', 'businessName')}
              {text('botName', 'botName')}
            </div>
            {text('botIdentity', 'botIdentity', true)}
          </div>

          <div className="card">
            <div className="grid2">
              <label className="field">
                <span>{t('tone')}</span>
                <select value={s.tone} onChange={(e) => set('tone', e.target.value as BotSettings['tone'])}>
                  <option value="friendly">{t('tone_friendly')}</option>
                  <option value="professional">{t('tone_professional')}</option>
                  <option value="concise">{t('tone_concise')}</option>
                </select>
              </label>
              <label className="field">
                <span>{t('emoji')}</span>
                <select value={s.emoji} onChange={(e) => set('emoji', e.target.value as BotSettings['emoji'])}>
                  <option value="none">{t('emoji_none')}</option>
                  <option value="sometimes">{t('emoji_sometimes')}</option>
                  <option value="often">{t('emoji_often')}</option>
                </select>
              </label>
            </div>
            {text('toneExtra', 'toneExtra', true)}
            {num('maxSentences', 'maxSentences')}
          </div>

          <div className="card">
            {list('forbiddenTopics', 'forbiddenTopics')}
            {list('forbiddenKeywords', 'forbiddenKeywords')}
            {list('handoffKeywords', 'handoffKeywords')}
            {text('handoffReply', 'handoffReply', true)}
            {text('unknownReply', 'unknownReply', true)}
          </div>

          <div className="card">
            <label className="check"><input type="checkbox" checked={s.greetingEnabled} onChange={(e) => set('greetingEnabled', e.target.checked)} /> {t('greeting')}</label>
            {s.greetingEnabled && <textarea value={s.greeting} onChange={(e) => set('greeting', e.target.value)} style={{ marginBottom: 14 }} />}
            <label className="check"><input type="checkbox" checked={s.collectLeads} onChange={(e) => set('collectLeads', e.target.checked)} /> {t('collectLeads')}</label>
            <label className="check"><input type="checkbox" checked={s.autoResumeEnabled} onChange={(e) => set('autoResumeEnabled', e.target.checked)} /> {t('autoResume')}</label>
            {s.autoResumeEnabled && num('autoResumeHours', 'autoResumeHours')}
          </div>

          <div className="card">
            <h3>{t('voiceCard')}</h3>
            <label className="check"><input type="checkbox" checked={s.voiceEnabled} onChange={(e) => set('voiceEnabled', e.target.checked)} /> {t('voiceEnabled')}</label>
            {s.voiceEnabled && text('voiceFailReply', 'voiceFailReply', true)}
            <p className="hint">{t('voiceHint')}</p>
          </div>

          <div className="card">
            <h3>{t('followUpCard')}</h3>
            <label className="check"><input type="checkbox" checked={s.followUpEnabled} onChange={(e) => set('followUpEnabled', e.target.checked)} /> {t('followUpEnabled')}</label>
            {s.followUpEnabled && (
              <>
                <div className="grid2">
                  {num('followUpCount', 'followUpCount')}
                  {num('followUpMinutes1', 'followUpMinutes1')}
                </div>
                {text('followUpText', 'followUpText', true)}
                {s.followUpCount >= 2 && num('followUpMinutes2', 'followUpMinutes2')}
                {s.followUpCount >= 2 && text('followUpText2', 'followUpText2', true)}
                <div className="row">
                  <button type="button" onClick={async () => { try { const r = await post<{ checked: number; sent: number }>('/followups/run'); setMsg(t('followUpRan', r)); } catch (e) { setErr((e as Error).message); } }}>{t('followUpRun')}</button>
                </div>
              </>
            )}
            <p className="hint">{t('followUpHint')}</p>
          </div>

          <details className="card">
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('advanced')}</summary>
            <div style={{ marginTop: 14 }}>
              <div className="grid2">
                {num('historyLimit', 'historyLimit')}
                {num('rateLimitPerMinute', 'rateLimit')}
                {text('model', 'model')}
                {text('llmBaseUrl', 'llmBaseUrl')}
              </div>
              {num('retentionDays', 'retentionDays')}
            </div>
          </details>
        </fieldset>

        <TestChat settings={s} />
      </div>
    </div>
  );
}

interface Tpl {
  id: string;
  name: { zh: string; en: string };
  summary: { zh: string; en: string };
}

function Templates({ onApplied }: { onApplied: (s: BotSettings) => void }) {
  const { t, lang } = useI18n();
  const [list, setList] = useState<Tpl[]>([]);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api<{ templates: Tpl[] }>('/templates').then((r) => setList(r.templates));
  }, []);
  const apply = async (tpl: Tpl) => {
    if (!confirm(t('applyConfirm', { name: tpl.name[lang] }))) return;
    try {
      const r = await post<{ settings: BotSettings }>(`/templates/${tpl.id}/apply`);
      onApplied(r.settings);
      setMsg(`${t('applied')}：${tpl.name[lang]}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <details className="card">
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('templates')} {msg && <span className="ok" style={{ fontWeight: 400, marginLeft: 8 }}>{msg}</span>}</summary>
      <p className="hint">{t('templatesHint')}</p>
      <div className="tpl-grid">
        {list.map((tpl) => (
          <div key={tpl.id} className="tpl">
            <b>{tpl.name[lang]}</b>
            <div className="s">{tpl.summary[lang]}</div>
            <button className="small" onClick={() => apply(tpl)}>{t('applyTemplate')}</button>
          </div>
        ))}
      </div>
    </details>
  );
}

interface TMsg {
  role: 'customer' | 'bot';
  text: string;
  trace?: string;
  media?: Media;
}

function TestChat({ settings }: { settings: BotSettings }) {
  const { t } = useI18n();
  const [msgs, setMsgs] = useState<TMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [stageId, setStageId] = useState<string | null>(null);
  const [stageName, setStageName] = useState<string | null>(null);
  const [sentMedia, setSentMedia] = useState<string[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next: TMsg[] = [...msgs, { role: 'customer', text }];
    if (!msgs.length && settings.greetingEnabled && settings.greeting.trim()) next.splice(0, 0, { role: 'bot', text: settings.greeting.trim(), trace: t('greeting') });
    setMsgs(next);
    setInput('');
    setBusy(true);
    try {
      const r = await post<{
        reply: string;
        handoffReason: string | null;
        lead: Record<string, string> | null;
        toolLog: { name: string; args: unknown }[];
        kb: { title: string; score: number }[];
        media: Media[];
        stageId: string | null;
        stageName: string | null;
      }>('/test-chat', {
        messages: next.filter((m) => !m.media).map(({ role, text }) => ({ role, text })),
        settings,
        stageId,
        sentMedia,
      });
      const trace: string[] = [];
      if (r.handoffReason) trace.push(`→ ${t('handoffReason')}: ${r.handoffReason}`);
      if (r.toolLog.length) trace.push(`${t('toolsUsed')}: ${r.toolLog.map((x) => `${x.name}(${JSON.stringify(x.args)})`).join(', ')}`);
      if (r.kb.length) trace.push(`${t('kbUsed')}: ${r.kb.map((k) => `${k.title} (${k.score})`).join(', ')}`);
      if (r.stageId !== stageId && r.stageName) trace.push(`→ ${t('currentStage')}: ${r.stageName}`);
      setStageId(r.stageId);
      setStageName(r.stageName);
      setSentMedia([...new Set([...sentMedia, ...r.media.map((m) => m.id)])]);
      setMsgs([
        ...next,
        { role: 'bot', text: r.reply || '（没有回复）', trace: trace.join('\n') },
        ...r.media.map((m): TMsg => ({ role: 'bot', text: `[${m.kind === 'image' ? '图片' : '视频'}] ${m.title}`, media: m })),
      ]);
    } catch (e) {
      setMsgs([...next, { role: 'bot', text: '⚠️ ' + (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card test-chat">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{t('testChat')}</h2>
        <button className="small" onClick={() => { setMsgs([]); setStageId(null); setStageName(null); setSentMedia([]); }}>{t('reset')}</button>
      </div>
      {stageName && <div className="hint" style={{ margin: '4px 0 0' }}>{t('currentStage')}：<b>{stageName}</b></div>}
      <p className="hint" style={{ marginBottom: 0 }}>{t('testHint')}</p>
      <div className="chat-body" ref={bodyRef}>
        {msgs.map((m, i) => (
          <div key={i} className={'msg ' + m.role}>
            {m.media ? (
              <div>
                <MediaThumb m={m.media} size={140} />
                <div className="trace">{m.text}</div>
              </div>
            ) : (
              <div className="bubble">{m.text}</div>
            )}
            {m.trace && <div className="trace" style={{ whiteSpace: 'pre-wrap' }}>{m.trace}</div>}
          </div>
        ))}
        {busy && <div className="msg bot"><div className="bubble">…</div></div>}
      </div>
      <div className="row">
        <input
          className="grow"
          value={input}
          placeholder={t('testPlaceholder')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && send()}
        />
        <button className="primary" onClick={send} disabled={busy}>{t('send')}</button>
      </div>
    </div>
  );
}
