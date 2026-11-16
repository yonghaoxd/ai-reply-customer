import { useEffect, useState } from 'react';
import { api, put, type Media } from '../api';
import { useI18n } from '../i18n';
import { MediaThumb } from '../components/MediaThumb';
import type { Me } from '../App';

export interface Stage {
  id?: string;
  name: string;
  goal: string;
  script: string;
  exitWhen: string;
  followUp: string;
  mediaIds: string[];
}

export function SopPage({ me }: { me: Me }) {
  const { t } = useI18n();
  const [stages, setStages] = useState<Stage[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [media, setMedia] = useState<Media[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [dirty, setDirty] = useState(false);
  const isOwner = me.role === 'owner';

  const load = () => {
    api<{ stages: Stage[]; counts: Record<string, number> }>('/sop').then((r) => {
      setStages(r.stages);
      setCounts(r.counts);
      setDirty(false);
    });
    api<{ media: Media[] }>('/media').then((r) => setMedia(r.media));
  };
  useEffect(load, []);
  if (!stages) return <div className="page">{t('loading')}</div>;

  const update = (i: number, patchS: Partial<Stage>) => {
    setStages(stages.map((s, j) => (j === i ? { ...s, ...patchS } : s)));
    setDirty(true);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= stages.length) return;
    const next = [...stages];
    [next[i], next[j]] = [next[j], next[i]];
    setStages(next);
    setDirty(true);
  };
  const save = async () => {
    setErr('');
    try {
      const r = await put<{ stages: Stage[] }>('/sop', { stages });
      setStages(r.stages);
      setDirty(false);
      setMsg(t('saved'));
      setTimeout(() => setMsg(''), 2000);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('navSop')}</h1>
          <p className="hint">{t('sopHint')}</p>
        </div>
        <div className="row">
          {msg && <span className="ok">{msg}</span>}
          {isOwner && <button className="primary" onClick={save} disabled={!dirty}>{t('save')}</button>}
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      <fieldset disabled={!isOwner} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {stages.map((st, i) => (
          <div key={st.id ?? 'new' + i} className="card">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <div className="row">
                <span className="badge accent">{t('stage')} {i + 1}</span>
                {st.id && <span className="hint" style={{ margin: 0 }}>{t('customersInStage', { n: counts[st.id] ?? 0 })}</span>}
              </div>
              <div className="row">
                <button className="small" disabled={i === 0} onClick={() => move(i, -1)}>↑ {t('moveUp')}</button>
                <button className="small" disabled={i === stages.length - 1} onClick={() => move(i, 1)}>↓ {t('moveDown')}</button>
                <button className="small danger" onClick={() => { if (confirm(t('confirmDelete'))) { setStages(stages.filter((_, j) => j !== i)); setDirty(true); } }}>{t('delete')}</button>
              </div>
            </div>
            <label className="field"><span>{t('stageName')}</span><input value={st.name} onChange={(e) => update(i, { name: e.target.value })} /></label>
            <label className="field"><span>{t('goal')}</span><textarea value={st.goal} onChange={(e) => update(i, { goal: e.target.value })} style={{ minHeight: 50 }} /></label>
            <label className="field"><span>{t('script')}</span><textarea value={st.script} onChange={(e) => update(i, { script: e.target.value })} /></label>
            <label className="field"><span>{t('exitWhen')}</span><input value={st.exitWhen} onChange={(e) => update(i, { exitWhen: e.target.value })} /></label>
            <label className="field"><span>{t('stageFollowUp')}</span><textarea value={st.followUp} onChange={(e) => update(i, { followUp: e.target.value })} style={{ minHeight: 50 }} /></label>
            <div className="field">
              <span style={{ display: 'block', fontWeight: 600, marginBottom: 6, fontSize: 13 }}>{t('stageMedia')}</span>
              {media.length === 0 && <p className="hint">{t('noMedia')}</p>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {media.map((m) => {
                  const on = st.mediaIds.includes(m.id);
                  return (
                    <label key={m.id} style={{ width: 96, cursor: 'pointer', opacity: on ? 1 : 0.55, outline: on ? '2px solid var(--accent)' : 'none', borderRadius: 8, padding: 2 }}>
                      <input
                        type="checkbox"
                        checked={on}
                        style={{ display: 'none' }}
                        onChange={() => update(i, { mediaIds: on ? st.mediaIds.filter((x) => x !== m.id) : [...st.mediaIds, m.id].slice(0, 5) })}
                      />
                      <MediaThumb m={m} size={92} />
                      <div style={{ fontSize: 11, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title || '-'}</div>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        ))}
        {isOwner && (
          <button onClick={() => { setStages([...stages, { name: '', goal: '', script: '', exitWhen: '', followUp: '', mediaIds: [] }]); setDirty(true); }}>+ {t('addStage')}</button>
        )}
      </fieldset>
    </div>
  );
}
