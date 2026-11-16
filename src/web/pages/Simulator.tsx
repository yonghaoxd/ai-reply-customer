import { useCallback, useEffect, useRef, useState } from 'react';
import { api, del, fmtTime, post } from '../api';
import { useI18n } from '../i18n';
import { TraceToggle, type Trace } from '../components/Trace';
import type { Customer } from './Inbox';

interface Msg {
  id: string;
  role: 'customer' | 'bot' | 'human' | 'system';
  text: string;
  createdAt: number;
  attachment: { type: string; url?: string; title?: string; transcript?: boolean } | null;
  trace: Trace | null;
}

export function Simulator({ selectedId, go, demo }: { selectedId?: string; go: (p: string) => void; demo?: boolean }) {
  const { t, lang } = useI18n();
  const [list, setList] = useState<Customer[] | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => api<{ customers: Customer[] }>('/sim/customers').then((r) => setList(r.customers)), []);
  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    setErr('');
    try {
      const r = await post<{ id: string }>('/sim/customers', {});
      await load();
      go('sim/' + r.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="sim">
      <div className="col">
        <div className="conv-filters">
          <button className="primary" style={{ width: '100%' }} onClick={create}>+ {t('newSim')}</button>
          {err && <div className="error">{err}</div>}
        </div>
        {list?.map((c) => (
          <a key={c.id} href={'#/sim/' + c.id} className={'conv-item' + (c.id === selectedId ? ' active' : '')}>
            <div className="top">
              <span className="nm">{c.name}</span>
              <span className="tm">{fmtTime(c.lastMessageAt, lang)}</span>
            </div>
            <div className="pv">{c.lastMessagePreview || '—'}</div>
          </a>
        ))}
        <p className="hint" style={{ padding: '12px 14px' }}>{t('simHint')}</p>
      </div>
      <div style={{ background: 'var(--bg)', height: 'var(--vh, 100vh)' }}>
        {selectedId ? (
          <SimChat key={selectedId} id={selectedId} go={go} reloadList={load} demo={demo} />
        ) : (
          <div className="empty" style={{ paddingTop: 100 }}>{t('simPick')}</div>
        )}
      </div>
    </div>
  );
}

function SimChat({ id, go, reloadList, demo }: { id: string; go: (p: string) => void; reloadList: () => void; demo?: boolean }) {
  const { t, lang } = useI18n();
  const [data, setData] = useState<{ customer: Customer; messages: Msg[] } | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string[]>([]); // 已发出、还在等 bot 的信息
  const [err, setErr] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    () =>
      api(`/conversations/${id}`)
        .then(setData)
        // 找不到这个顾客才回列表；其它错误要显示出来，不要默默跳走
        .catch((e) => ((e as { status?: number }).status === 404 ? go('sim') : setErr(t('loadFailed', { m: (e as Error).message })))),
    [id],
  );
  useEffect(() => {
    load();
    // 真人在 Inbox 回复时，这边也要看得到
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), 4000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }));
  }, [data?.messages.length, pending.length]);

  const sendAudio = async (file: File) => {
    setErr('');
    setPending((p) => [...p, t('transcribing')]);
    try {
      const res = await fetch(`/api/sim/customers/${id}/audio`, { method: 'PUT', credentials: 'same-origin', headers: { 'X-Requested-With': 'mcs', 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      await load();
      setPending((p) => p.slice(1));
      reloadList();
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    setErr('');
    setPending((p) => [...p, body]);
    try {
      await post(`/sim/customers/${id}/messages`, { text: body });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      await load();
      setPending((p) => p.slice(1));
      reloadList();
    }
  };

  if (!data) return err ? <div className="error" style={{ margin: 24 }}>{err}</div> : <div className="empty">{t('loading')}</div>;
  const c = data.customer;
  return (
    <div className="phone">
      <div className="chat-head">
        <div>
          <div className="who">{c.name} <span className="badge">{t('simBadge')}</span></div>
          <div className="state">{c.botPaused ? t('roleHuman') : t('botActive')}</div>
        </div>
        <div className="row">
          <button className="small" onClick={() => go('inbox/' + id)}>{t('openInInbox')}</button>
          <button className="small danger" onClick={async () => { if (confirm(t('confirmDelete'))) { await del(`/sim/customers/${id}`); reloadList(); go('sim'); } }}>{t('delete')}</button>
        </div>
      </div>
      {c.botPaused && <div className="error" style={{ margin: '10px 14px 0' }}>{t('simPaused')}</div>}
      <div className="chat-body" ref={bodyRef}>
        {data.messages.map((m) => (
          <div key={m.id} className={'msg ' + m.role}>
            {m.attachment?.url && (m.attachment.type === 'image' || m.attachment.type === 'video') ? (
              m.attachment.type === 'image' ? (
                <img src={m.attachment.url} alt="" style={{ maxWidth: 220, maxHeight: 220, borderRadius: 12 }} />
              ) : (
                <video src={m.attachment.url} controls preload="metadata" style={{ maxWidth: 240, borderRadius: 12 }} />
              )
            ) : (
              <div className="bubble">{m.attachment?.type === 'audio' && <div className="voice-tag" style={{ color: 'inherit', opacity: 0.8 }}>{m.attachment.transcript ? t('voiceMsg') : t('voiceUntranscribed')}</div>}{m.text}</div>
            )}
            <div className="meta">
              {m.role === 'human' ? t('roleHuman') + ' · ' : m.role === 'bot' ? t('roleBot') + ' · ' : ''}
              {fmtTime(m.createdAt, lang)}
            </div>
            {m.role === 'bot' && <TraceToggle trace={m.trace} />}
          </div>
        ))}
        {pending.map((p, i) => (
          <div key={'p' + i} className="msg customer" style={{ opacity: 0.6 }}><div className="bubble">{p}</div></div>
        ))}
        {pending.length > 0 && !c.botPaused && <div className="msg bot"><div className="bubble">{t('botThinking')}</div></div>}
      </div>
      <div className="composer">
        {err && <div className="error">{err}</div>}
        <div className="row">
          <input
            className="grow"
            value={text}
            placeholder={t('simPlaceholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && send()}
            autoFocus
          />
          {!demo && <label className="btn" title={t('sendVoice')}>
            🎤
            <input type="file" accept="audio/*,video/mp4,.m4a,.mp3,.wav,.ogg,.webm" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) sendAudio(f); }} />
          </label>}
          <button className="primary" onClick={send} disabled={!text.trim()}>{t('send')}</button>
        </div>
      </div>
    </div>
  );
}
