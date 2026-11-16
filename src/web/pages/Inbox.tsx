import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtDuration, fmtTime, patch, post, type Media } from '../api';
import { MediaThumb } from '../components/MediaThumb';
import { TraceToggle, type Trace } from '../components/Trace';
import { QuickReplies } from '../components/QuickReplies';
import type { Stage } from './Sop';
import { useI18n } from '../i18n';

export interface Customer {
  id: string;
  psid: string;
  name: string;
  profilePic: string | null;
  tags: string[];
  notes: string;
  summary: string;
  botPaused: boolean;
  pausedUntil: number | null;
  needsHuman: boolean;
  unread: number;
  lastInboundAt: number | null;
  lastMessageAt: number | null;
  lastMessagePreview: string;
  windowOpen: boolean;
  windowEndsAt: number | null;
  stageId: string | null;
  sentMedia: string[];
  isSim: boolean;
}

interface Msg {
  id: string;
  role: 'customer' | 'bot' | 'human' | 'system';
  text: string;
  createdAt: number;
  senderName: string | null;
  attachment: { type: string; url?: string; title?: string; transcript?: boolean } | null;
  trace: Trace | null;
}

function usePoll(fn: () => void, ms: number, deps: unknown[]) {
  useEffect(() => {
    fn();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fn();
    }, ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function Inbox({ selectedId, go }: { selectedId?: string; go: (p: string) => void }) {
  const { t, lang } = useI18n();
  const [filter, setFilter] = useState<'all' | 'unread' | 'human'>('all');
  const [q, setQ] = useState('');
  const [list, setList] = useState<Customer[] | null>(null);

  usePoll(
    () => {
      api<{ conversations: Customer[] }>(`/conversations?filter=${filter}&q=${encodeURIComponent(q)}`)
        .then((r) => setList(r.conversations))
        .catch(() => {});
    },
    5000,
    [filter, q],
  );

  return (
    <div className="inbox">
      <div className="col">
        <div className="conv-filters">
          <div className="tabs">
            {(['all', 'unread', 'human'] as const).map((f) => (
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {t(f === 'all' ? 'filterAll' : f === 'unread' ? 'filterUnread' : 'filterHuman')}
              </button>
            ))}
          </div>
          <input placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {list === null && <div className="empty">{t('loading')}</div>}
        {list?.length === 0 && <div className="empty">{t('noConversations')}</div>}
        {list?.map((c) => (
          <a key={c.id} href={'#/inbox/' + c.id} className={'conv-item' + (c.id === selectedId ? ' active' : '') + (c.unread ? ' unread' : '')}>
            <div className="top">
              <span className="nm">{c.name || c.psid}</span>
              <span className="tm">{fmtTime(c.lastMessageAt, lang)}</span>
            </div>
            <div className="pv">{c.lastMessagePreview}</div>
            {(c.isSim || c.needsHuman || c.botPaused || c.tags.length > 0) && (
              <div className="flags">
                {c.isSim && <span className="badge">{t('simBadge')}</span>}
                {c.needsHuman && <span className="badge danger">{t('needsHuman')}</span>}
                {c.botPaused && !c.needsHuman && <span className="badge warn">{t('roleHuman')}</span>}
                {c.tags.slice(0, 3).map((tg) => <span key={tg} className="badge accent">{tg}</span>)}
              </div>
            )}
          </a>
        ))}
      </div>
      {selectedId ? <Conversation key={selectedId} id={selectedId} go={go} /> : <div className="chat"><div className="empty" style={{ marginTop: 80 }}>{t('pickConversation')}</div></div>}
    </div>
  );
}

function Conversation({ id, go }: { id: string; go: (p: string) => void }) {
  const { t, lang } = useI18n();
  const [data, setData] = useState<{ customer: Customer; messages: Msg[]; lead: any; handoff: { reason: string } | null } | null>(null);
  const [text, setText] = useState('');
  const [humanAgent, setHumanAgent] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [quick, setQuick] = useState(false);
  const [library, setLibrary] = useState<Media[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ media: Media[] }>('/media').then((r) => setLibrary(r.media)).catch(() => {});
    api<{ stages: Stage[] }>('/sop').then((r) => setStages(r.stages)).catch(() => {});
  }, []);
  const lastCount = useRef(0);

  const load = useCallback(() => {
    api(`/conversations/${id}`)
      .then((r) => {
        setData(r);
        if (r.customer.unread) post(`/conversations/${id}/read`).catch(() => {});
      })
      .catch(() => go('inbox'));
  }, [id]);
  usePoll(load, 5000, [id]);

  useEffect(() => {
    if (data && data.messages.length !== lastCount.current) {
      lastCount.current = data.messages.length;
      requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }));
    }
  }, [data]);

  if (!data) return <div className="chat"><div className="empty">{t('loading')}</div></div>;
  const c = data.customer;
  const nowMs = Date.now();
  const windowLeft = c.windowEndsAt ? c.windowEndsAt - nowMs : 0;
  const tagWindowOpen = c.lastInboundAt ? nowMs - c.lastInboundAt < 7 * 86400_000 : false;
  const canSend = c.windowOpen || (humanAgent && tagWindowOpen);

  const send = async () => {
    if (!text.trim() || !canSend) return;
    setBusy(true);
    setErr('');
    try {
      await post(`/conversations/${id}/messages`, { text, humanAgent: !c.windowOpen && humanAgent });
      setText('');
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sendMedia = async (m: Media) => {
    setBusy(true);
    setErr('');
    setPicker(false);
    try {
      await post(`/conversations/${id}/media`, { mediaId: m.id, humanAgent: !c.windowOpen && humanAgent });
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const togglePause = async () => {
    await post(`/conversations/${id}/pause`, { paused: !c.botPaused });
    load();
  };

  const stateText = !c.botPaused
    ? t('botActive')
    : c.pausedUntil
      ? t('botPausedUntil', { t: fmtTime(c.pausedUntil, lang) })
      : t('botPausedForever');

  return (
    <>
      <div className="chat">
        <div className="chat-head">
          <div>
            <div className="who">{c.name || c.psid} {c.isSim && <span className="badge">{t('simBadge')}</span>}</div>
            <div className="state">
              {c.needsHuman && <span className="badge danger" style={{ marginRight: 6 }}>{t('needsHuman')}</span>}
              {stateText}
            </div>
          </div>
          <button className={c.botPaused ? '' : 'primary'} onClick={togglePause}>{c.botPaused ? t('giveBack') : t('takeOver')}</button>
        </div>
        {data.handoff && c.needsHuman && (
          <div className="error" style={{ margin: '10px 18px 0' }}>{t('handoffReason')}：{data.handoff.reason}</div>
        )}
        <div className="chat-body" ref={bodyRef}>
          {data.messages.map((m) => (
            <div key={m.id} className={'msg ' + m.role}>
              {m.attachment?.url && (m.attachment.type === 'image' || m.attachment.type === 'video') ? (
                <a href={m.attachment.url} target="_blank" rel="noreferrer" title={m.text}>
                  {m.attachment.type === 'image' ? (
                    <img src={m.attachment.url} alt={m.attachment.title || ''} style={{ maxWidth: 240, maxHeight: 240, borderRadius: 12, display: 'block' }} />
                  ) : (
                    <video src={m.attachment.url} controls preload="metadata" style={{ maxWidth: 260, borderRadius: 12, display: 'block' }} />
                  )}
                </a>
              ) : (
                <div className="bubble">{m.attachment?.type === 'audio' && <div className="voice-tag">{m.attachment.transcript ? t('voiceMsg') : t('voiceUntranscribed')}</div>}{m.text}</div>
              )}
              <div className="meta">
                {m.attachment?.title ? `${m.attachment.title} · ` : ''}
                {m.role === 'customer' ? t('roleCustomer') : m.role === 'bot' ? t('roleBot') : `${t('roleHuman')}${m.senderName ? ' · ' + m.senderName : ''}`} · {fmtTime(m.createdAt, lang)}
              </div>
              {m.role === 'bot' && <TraceToggle trace={m.trace} />}
            </div>
          ))}
        </div>
        <div className="composer">
          <textarea
            value={text}
            disabled={!canSend}
            placeholder={canSend ? t('typeReply') : t('windowClosed')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          {err && <div className="error">{err}</div>}
          <div className="row">
            <div className="grow info">
              {c.windowOpen ? t('windowLeft', { t: fmtDuration(windowLeft, lang) }) : t('windowClosed')}
              {!c.botPaused && c.windowOpen && <> · {t('sendingAsHuman')}</>}
              {!c.windowOpen && tagWindowOpen && (
                <label className="check" style={{ margin: '6px 0 0' }}>
                  <input type="checkbox" checked={humanAgent} onChange={(e) => setHumanAgent(e.target.checked)} /> {t('useHumanAgent')}
                </label>
              )}
            </div>
            <button onClick={() => { setQuick(!quick); setPicker(false); }} disabled={!canSend}>{t('quickReplies')}</button>
            <button onClick={() => { setPicker(!picker); setQuick(false); }} disabled={busy || !canSend || !library.length}>{t('sendMedia')}</button>
            <button className="primary" onClick={send} disabled={busy || !canSend || !text.trim()}>{t('send')}</button>
          </div>
          {quick && <QuickReplies onPick={(x) => { setText((cur) => (cur.trim() ? cur.trimEnd() + '\n' + x : x)); setQuick(false); }} onClose={() => setQuick(false)} />}
          {picker && (
            <div className="card" style={{ marginTop: 10, marginBottom: 0, maxHeight: 260, overflow: 'auto' }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <b>{t('pickMedia')}</b>
                <button className="small" onClick={() => setPicker(false)}>{t('close')}</button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {library.map((m) => (
                  <button key={m.id} onClick={() => sendMedia(m)} style={{ padding: 4, width: 104, textAlign: 'left' }} title={m.title}>
                    <MediaThumb m={m} size={94} />
                    <div style={{ fontSize: 11, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.sentMedia.includes(m.id) ? '✓ ' : ''}{m.title || '-'}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="col side-col">
        <CustomerPanel customer={c} lead={data.lead} stages={stages} onSaved={load} />
      </div>
    </>
  );
}

export function CustomerPanel({ customer, lead, stages, onSaved }: { customer: Customer; lead?: any; stages?: Stage[]; onSaved?: () => void }) {
  const { t } = useI18n();
  const [tags, setTags] = useState(customer.tags);
  const [tagInput, setTagInput] = useState('');
  const [notes, setNotes] = useState(customer.notes);
  const [summary, setSummary] = useState(customer.summary);
  const [savedMsg, setSavedMsg] = useState('');

  useEffect(() => {
    setTags(customer.tags);
    setNotes(customer.notes);
    setSummary(customer.summary);
  }, [customer.id]);

  const save = async (next: Partial<{ tags: string[]; notes: string; summary: string }>) => {
    await patch(`/customers/${customer.id}`, { tags, notes, summary, ...next });
    setSavedMsg(t('saved'));
    setTimeout(() => setSavedMsg(''), 1500);
    onSaved?.();
  };
  const addTag = () => {
    const v = tagInput.trim();
    if (!v || tags.includes(v)) return setTagInput('');
    const next = [...tags, v];
    setTags(next);
    setTagInput('');
    save({ tags: next });
  };

  return (
    <div className="side">
      <div className="section row">
        {customer.profilePic ? <img className="avatar" src={customer.profilePic} alt="" /> : <div className="avatar" />}
        <div>
          <div style={{ fontWeight: 600 }}>{customer.name || customer.psid}</div>
          <div className="hint" style={{ margin: 0 }}>PSID {customer.psid}</div>
        </div>
      </div>
      {!!stages?.length && (
        <div className="section">
          <h3>{t('currentStage')}</h3>
          <select
            value={customer.stageId ?? ''}
            onChange={async (e) => { await post(`/conversations/${customer.id}/stage`, { stageId: e.target.value || null }); onSaved?.(); }}
          >
            <option value="">{t('noStage')}</option>
            {stages.map((st, i) => <option key={st.id} value={st.id}>{i + 1}. {st.name}</option>)}
          </select>
        </div>
      )}
      <div className="section">
        <h3>{t('tags')}</h3>
        <div className="tags">
          {tags.map((tg) => (
            <span key={tg} className="tag">
              {tg}
              <button onClick={() => { const next = tags.filter((x) => x !== tg); setTags(next); save({ tags: next }); }}>×</button>
            </span>
          ))}
        </div>
        <input placeholder={t('addTag')} value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && addTag()} />
      </div>
      {lead && (
        <div className="section">
          <h3>{t('leadInfo')}</h3>
          <div className="kv"><b>{t('name')}</b>{lead.name || '-'}</div>
          <div className="kv"><b>{t('phone')}</b>{lead.phone || '-'}</div>
          <div className="kv"><b>{t('email')}</b>{lead.email || '-'}</div>
          <div className="kv"><b>{t('interest')}</b>{lead.interest || '-'}</div>
          <div className="kv"><b>{t('status')}</b>{t(('lead_' + lead.status) as any)}</div>
        </div>
      )}
      <div className="section">
        <h3>{t('notes')}</h3>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== customer.notes && save({ notes })} />
      </div>
      <div className="section">
        <h3>{t('summary')}</h3>
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} onBlur={() => summary !== customer.summary && save({ summary })} style={{ minHeight: 110 }} />
        {savedMsg && <span className="ok" style={{ fontSize: 12 }}>{savedMsg}</span>}
      </div>
    </div>
  );
}
