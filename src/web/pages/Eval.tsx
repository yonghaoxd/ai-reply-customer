import { useEffect, useState } from 'react';
import { api, del, fmtTime, patch, post } from '../api';
import { useI18n } from '../i18n';
import type { EvalCaseResult, EvalChecks } from '../../shared/evals';
import type { Me } from '../App';

interface Case {
  id: string;
  question: string;
  checks: EvalChecks;
}
interface Run {
  id: string;
  model: string;
  total: number;
  passed: number;
  createdAt: number;
  results?: EvalCaseResult[];
}
interface Draft {
  id?: string;
  question: string;
  handoff: '' | 'must' | 'mustNot';
  include: string;
  includeAny: string;
  exclude: string;
  noPrice: boolean;
  saveLead: boolean;
  judge: string;
}

const EMPTY: Draft = { question: '', handoff: '', include: '', includeAny: '', exclude: '', noPrice: false, saveLead: false, judge: '' };
const split = (s: string) => s.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
const toDraft = (c: Case): Draft => ({
  id: c.id, question: c.question, handoff: c.checks.handoff ?? '', include: (c.checks.include ?? []).join(', '), includeAny: (c.checks.includeAny ?? []).join(', '),
  exclude: (c.checks.exclude ?? []).join(', '), noPrice: !!c.checks.noPrice, saveLead: !!c.checks.saveLead, judge: c.checks.judge ?? '',
});
const toChecks = (d: Draft): EvalChecks => ({
  ...(d.handoff ? { handoff: d.handoff } : {}), include: split(d.include), includeAny: split(d.includeAny), exclude: split(d.exclude),
  noPrice: d.noPrice, saveLead: d.saveLead, judge: d.judge,
});

export function EvalPage({ me }: { me: Me }) {
  const { t, lang } = useI18n();
  const [cases, setCases] = useState<Case[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [live, setLive] = useState<Record<string, EvalCaseResult>>({}); // 正在跑的这一次
  const [progress, setProgress] = useState<{ i: number; n: number } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState('');
  const isOwner = me.role === 'owner' && !me.demo;

  const load = () =>
    api<{ cases: Case[]; runs: Run[] }>('/eval')
      .then((r) => {
        setCases(r.cases);
        setRuns(r.runs);
      })
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
  }, []);
  if (!cases) return <div className="page">{err ? <div className="error">{err}</div> : t('loading')}</div>;

  const runAll = async () => {
    setErr('');
    setLive({});
    setProgress({ i: 0, n: cases.length });
    try {
      const { id } = await post<{ id: string }>('/eval/runs');
      // 一题一题跑：每题是一次独立请求，中途出错也保留已经跑完的
      for (let i = 0; i < cases.length; i++) {
        setProgress({ i: i + 1, n: cases.length });
        const { result } = await post<{ result: EvalCaseResult }>(`/eval/runs/${id}/cases/${cases[i].id}`);
        setLive((l) => ({ ...l, [cases[i].id]: result }));
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setProgress(null);
      await load();
      setLive({});
    }
  };

  const save = async () => {
    if (!draft) return;
    setErr('');
    try {
      const body = { question: draft.question, checks: toChecks(draft) };
      if (draft.id) await patch(`/eval/cases/${draft.id}`, body);
      else await post('/eval/cases', body);
      setDraft(null);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const latest = runs[0];
  const byCase = new Map((latest?.results ?? []).map((r) => [r.caseId, r]));
  const resultOf = (id: string) => live[id] ?? (progress ? undefined : byCase.get(id));
  const liveList = Object.values(live);
  const score = progress ? { passed: liveList.filter((r) => r.pass).length, total: liveList.length } : latest ? { passed: latest.passed, total: latest.total } : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('navEval')}</h1>
          <p className="hint">{t('evalHint')}</p>
        </div>
        <button className="primary" disabled={!!progress || !cases.length} onClick={runAll}>{progress ? t('evalRunning', progress) : t('evalRun')}</button>
      </div>
      {err && <div className="error">{err}</div>}

      <div className="card">
        <div className="eval-score">
          <div>
            <div className="hint" style={{ margin: 0 }}>{t('evalPassRate')}</div>
            <div className="big">{score && score.total ? Math.round((score.passed / score.total) * 100) + '%' : '–'}</div>
          </div>
          <div className="hint" style={{ margin: 0 }}>
            {score ? t('evalPassed', { p: score.passed, n: score.total }) : t('evalNever')}
            {latest && !progress && <> · {latest.model} · {fmtTime(latest.createdAt, lang)}</>}
          </div>
        </div>
        {runs.length > 1 && (
          <>
            <div className="hint" style={{ margin: '12px 0 0' }}>{t('evalHistory')}</div>
            <div className="eval-runs">
              {runs.map((r) => (
                <span key={r.id} className={'badge ' + (r.total && r.passed === r.total ? 'ok' : r.total ? 'warn' : '')} title={r.model}>
                  {fmtTime(r.createdAt, lang)} · {r.passed}/{r.total}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {!cases.length && <div className="card empty">{t('evalEmpty')}</div>}
      {cases.map((c) => {
        const r = resultOf(c.id);
        return draft?.id === c.id ? (
          <CaseForm key={c.id} draft={draft} setDraft={setDraft} save={save} />
        ) : (
          <div key={c.id} className="eval-case">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div className="q">
                {r && <span className={'badge ' + (r.pass ? 'ok' : 'danger')} style={{ marginRight: 8 }}>{r.pass ? '✓ ' + t('evalPass') : '✗ ' + t('evalFail')}</span>}
                {c.question}
              </div>
              {isOwner && (
                <div className="row" style={{ flexShrink: 0 }}>
                  <button className="small" onClick={() => setDraft(toDraft(c))}>{t('edit')}</button>
                  <button className="small danger" onClick={async () => { if (confirm(t('confirmDelete'))) { await del(`/eval/cases/${c.id}`); load(); } }}>{t('delete')}</button>
                </div>
              )}
            </div>
            {r ? (
              <>
                {r.error ? <div className="error">{r.error}</div> : <div className="reply">{r.reply || t('none')}</div>}
                <div className="eval-checks">
                  {r.checks.map((k, i) => (
                    <div key={i}>
                      {k.pass ? '✅' : '❌'} <CheckLabel label={k.label} />
                      {k.detail && <span className="detail"> — {k.detail}</span>}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="eval-chips">
                {checkLabels(c.checks).map((l) => <span key={l} className="badge"><CheckLabel label={l} /></span>)}
                {!progress && latest && <span className="hint" style={{ margin: 0 }}>{t('evalNotRun')}</span>}
              </div>
            )}
          </div>
        );
      })}

      {isOwner && (draft && !draft.id ? (
        <CaseForm draft={draft} setDraft={setDraft} save={save} />
      ) : (
        <div className="row">
          <button onClick={() => setDraft({ ...EMPTY })}>+ {t('evalAddCase')}</button>
          <button onClick={async () => { try { await post('/eval/cases', { defaults: true }); load(); } catch (e) { setErr((e as Error).message); } }}>{t('evalLoadDefaults')}</button>
        </div>
      ))}
    </div>
  );
}

/** 跟后端 runEvalCase 产生的 label 一样的格式 */
function checkLabels(c: EvalChecks): string[] {
  return [
    ...(c.handoff ? [`handoff:${c.handoff}`] : []),
    ...(c.include ?? []).map((w) => `include:${w}`),
    ...(c.includeAny?.length ? [`includeAny:${c.includeAny.join(' / ')}`] : []),
    ...(c.exclude ?? []).map((w) => `exclude:${w}`),
    ...(c.noPrice ? ['noPrice'] : []),
    ...(c.saveLead ? ['saveLead'] : []),
    ...(c.judge ? [`judge:${c.judge}`] : []),
  ];
}

function CheckLabel({ label }: { label: string }) {
  const { t } = useI18n();
  const i = label.indexOf(':');
  const kind = i < 0 ? label : label.slice(0, i);
  const w = i < 0 ? '' : label.slice(i + 1);
  if (kind === 'handoff') return <>{t(w === 'must' ? 'ck_handoffMust' : 'ck_handoffMustNot')}</>;
  if (kind === 'include') return <>{t('ck_include', { w })}</>;
  if (kind === 'includeAny') return <>{t('ck_includeAny', { w })}</>;
  if (kind === 'exclude') return <>{t('ck_exclude', { w })}</>;
  if (kind === 'noPrice') return <>{t('ck_noPrice')}</>;
  if (kind === 'saveLead') return <>{t('ck_saveLead')}</>;
  if (kind === 'judge') return <>{t('ck_judge', { w })}</>;
  return <>{label}</>;
}

function CaseForm({ draft, setDraft, save }: { draft: Draft; setDraft: (d: Draft | null) => void; save: () => void }) {
  const { t } = useI18n();
  const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  return (
    <div className="card">
      <label className="field"><span>{t('evalQuestion')}</span><textarea value={draft.question} onChange={(e) => set({ question: e.target.value })} style={{ minHeight: 50 }} autoFocus /></label>
      <h3>{t('evalExpect')}</h3>
      <div className="grid2">
        <label className="field">
          <span>{t('evalHandoff')}</span>
          <select value={draft.handoff} onChange={(e) => set({ handoff: e.target.value as Draft['handoff'] })}>
            <option value="">{t('evalAny')}</option>
            <option value="must">{t('evalMust')}</option>
            <option value="mustNot">{t('evalMustNot')}</option>
          </select>
        </label>
        <label className="field"><span>{t('evalInclude')}</span><input value={draft.include} onChange={(e) => set({ include: e.target.value })} placeholder="RM 449" /></label>
        <label className="field"><span>{t('evalIncludeAny')}</span><input value={draft.includeAny} onChange={(e) => set({ includeAny: e.target.value })} /></label>
        <label className="field"><span>{t('evalExclude')}</span><input value={draft.exclude} onChange={(e) => set({ exclude: e.target.value })} /></label>
      </div>
      <label className="field"><span>{t('evalJudge')}</span><input value={draft.judge} onChange={(e) => set({ judge: e.target.value })} /></label>
      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={draft.noPrice} onChange={(e) => set({ noPrice: e.target.checked })} />{t('evalNoPrice')}</label>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={draft.saveLead} onChange={(e) => set({ saveLead: e.target.checked })} />{t('evalSaveLead')}</label>
      </div>
      <div className="row">
        <button className="primary" onClick={save}>{t('save')}</button>
        <button onClick={() => setDraft(null)}>{t('cancel')}</button>
      </div>
    </div>
  );
}
