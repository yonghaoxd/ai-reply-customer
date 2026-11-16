import { useEffect, useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';

interface Report {
  days: number;
  daily: { day: number; customer: number; bot: number; human: number }[];
  totals: {
    active: number; newCustomers: number; inbound: number; botReplies: number; humanReplies: number; leads: number; handoffs: number;
    withHuman: number; botOnly: number; aiReplies: number; avgMs: number; tokens: number; voice: number; followUps: number;
  };
  funnel: { id: string; name: string; here: number; leads: number; reached: number }[];
  noStage: number;
  handoffSources: Record<string, number>;
}

// 图表颜色：按身份固定（顾客 / Bot / 真人），已用 dataviz 的 validator 检查过色盲可分辨
const SERIES = [
  { key: 'customer', color: '#2563eb', label: 'roleCustomer' },
  { key: 'bot', color: '#0d9488', label: 'roleBot' },
  { key: 'human', color: '#d97706', label: 'roleHuman' },
] as const;

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export function Reports() {
  const { t, lang } = useI18n();
  const [days, setDays] = useState(14);
  const [sim, setSim] = useState(true);
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setErr('');
    api<Report>(`/reports?days=${days}&tz=${-new Date().getTimezoneOffset()}&sim=${sim ? 1 : 0}`)
      .then(setR)
      .catch((e) => setErr((e as Error).message));
  }, [days, sim]);

  const T = r?.totals;
  const nf = (n: number) => n.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-MY');
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('navReports')}</h1>
          <p className="hint">{t('reportsHint')}</p>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <label className="row" style={{ gap: 6, fontSize: 13, whiteSpace: 'nowrap' }}><input type="checkbox" checked={sim} onChange={(e) => setSim(e.target.checked)} />{t('includeSim')}</label>
          <div className="seg">
            {[7, 14, 30].map((n) => <button key={n} className={'small' + (days === n ? ' on' : '')} onClick={() => setDays(n)}>{t('lastDays', { n })}</button>)}
          </div>
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      {!r || !T ? (
        !err && <div className="empty">{t('loading')}</div>
      ) : T.active === 0 && T.inbound === 0 ? (
        <div className="card empty">{t('rNoData')}</div>
      ) : (
        <>
          <div className="stats stats3">
            <Tile n={nf(T.active)} l={t('rActive')} s={t('rNew', { n: T.newCustomers })} />
            <Tile n={nf(T.inbound)} l={t('rInbound')} s={t('rBotReplies', { n: nf(T.botReplies) })} />
            <Tile n={pct(T.leads, T.active) + '%'} l={t('rLeadRate')} s={t('rLeadsOf', { n: T.leads, a: T.active })} />
            <Tile n={pct(T.botOnly, T.active) + '%'} l={t('rBotSolved')} s={t('rBotSolvedOf', { n: T.botOnly, h: T.withHuman })} />
            <Tile n={T.aiReplies ? (T.avgMs / 1000).toFixed(1) + 's' : '–'} l={t('rAvgTime')} s={t('rAiReplies', { n: nf(T.aiReplies) })} />
            <Tile n={nf(T.tokens)} l={t('rTokens')} s={t('rVoiceFollow', { v: T.voice, f: T.followUps })} />
          </div>

          <div className="card">
            <h2>{t('rDailyTitle')}</h2>
            <DailyChart r={r} />
          </div>

          <div className="report-2col">
            <div className="card">
              <h2>{t('rFunnelTitle')}</h2>
              <p className="hint">{t('rFunnelHint')}</p>
              <Funnel r={r} />
            </div>
            <div className="card">
              <h2>{t('rOutcomeTitle')}</h2>
              <Outcome r={r} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ n, l, s }: { n: string; l: string; s: string }) {
  return (
    <div className="stat">
      <div className="l">{l}</div>
      <div className="n">{n}</div>
      <div className="l">{s}</div>
    </div>
  );
}

function niceMax(v: number) {
  // 4 格刻度，每格都是整数：1、2、3、5、10、20…
  const p = 10 ** Math.floor(Math.log10(Math.max(1, v / 4)));
  const step = [1, 2, 3, 5, 10].map((m) => m * p).find((x) => x * 4 >= v) ?? 10 * p;
  return step * 4;
}

/** 每天的信息量：堆叠柱（顾客 / Bot / 真人） */
function DailyChart({ r }: { r: Report }) {
  const { t, lang } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const W = 760, H = 220, L = 34, B = 24, TOP = 8;
  const max = niceMax(Math.max(...r.daily.map((d) => d.customer + d.bot + d.human)));
  const step = (W - L) / r.daily.length;
  const bw = Math.min(28, step * 0.62);
  const y = (v: number) => TOP + (H - TOP - B) * (1 - v / max);
  const fmt = (ms: number, long = false) => new Date(ms).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-MY', long ? { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' } : { month: 'numeric', day: 'numeric', timeZone: 'UTC' });
  const every = Math.ceil(r.daily.length / 10);
  const h = hover === null ? null : r.daily[hover];
  return (
    <div>
      <div className="legend">
        {SERIES.map((s) => <span key={s.key}><i style={{ background: s.color }} />{t(s.label)}</span>)}
      </div>
      <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('rDailyTitle')} style={{ width: '100%', height: 'auto', display: 'block' }}>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line x1={L} x2={W} y1={y(max * f)} y2={y(max * f)} stroke="#e3e6ea" strokeWidth={f === 0 ? 1.2 : 1} strokeDasharray={f === 0 ? undefined : '2 4'} />
              <text x={L - 6} y={y(max * f) + 4} textAnchor="end" fontSize="11" fill="#646b75">{Math.round(max * f)}</text>
            </g>
          ))}
          {r.daily.map((d, i) => {
            const cx = L + step * i + step / 2;
            let acc = 0;
            const segs = SERIES.filter((s) => d[s.key] > 0);
            return (
              <g key={d.day}>
                {hover === i && <rect x={cx - step / 2} y={TOP} width={step} height={H - TOP - B} fill="#f0f2f5" />}
                {segs.map((s, si) => {
                  const y1 = y(acc + d[s.key]);
                  const y0 = y(acc);
                  acc += d[s.key];
                  const top = si === segs.length - 1;
                  const hgt = Math.max(1, y0 - y1 - (top ? 0 : 2)); // 段和段之间留 2px 空隙
                  return top ? (
                    <path key={s.key} fill={s.color} d={`M${cx - bw / 2},${y1 + hgt} v${-(hgt - Math.min(4, hgt))} q0,${-Math.min(4, hgt)} ${Math.min(4, hgt)},${-Math.min(4, hgt)} h${bw - 2 * Math.min(4, hgt)} q${Math.min(4, hgt)},0 ${Math.min(4, hgt)},${Math.min(4, hgt)} v${hgt - Math.min(4, hgt)} z`} />
                  ) : (
                    <rect key={s.key} x={cx - bw / 2} y={y1 + 2} width={bw} height={hgt} fill={s.color} />
                  );
                })}
                {i % every === 0 && <text x={cx} y={H - 6} textAnchor="middle" fontSize="11" fill="#646b75">{fmt(d.day)}</text>}
                <rect x={cx - step / 2} y={0} width={step} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
        {h && hover !== null && (
          <div className="chart-tip" style={{ left: `${((L + step * hover + step / 2) / W) * 100}%` }}>
            <b>{fmt(h.day, true)}</b>
            {SERIES.map((s) => <div key={s.key}><i style={{ background: s.color }} />{t(s.label)}<span>{h[s.key]}</span></div>)}
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>{t('rTable')}</summary>
        <table className="list">
          <thead><tr><th>{t('date')}</th>{SERIES.map((s) => <th key={s.key}>{t(s.label)}</th>)}</tr></thead>
          <tbody>{r.daily.map((d) => <tr key={d.day}><td>{fmt(d.day, true)}</td>{SERIES.map((s) => <td key={s.key}>{d[s.key]}</td>)}</tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

/** SOP 漏斗：每一步「到过」的人数（深色）和其中「停在这里」的人数 */
function Funnel({ r }: { r: Report }) {
  const { t } = useI18n();
  const top = Math.max(1, r.funnel[0]?.reached ?? 0);
  return (
    <div>
      {r.funnel.map((f, i) => {
        const prev = i === 0 ? null : r.funnel[i - 1].reached;
        return (
          <div key={f.id} className="funnel-row" title={`${f.name}: ${t('rReached')} ${f.reached} · ${t('rHere')} ${f.here}`}>
            <div className="funnel-label"><span>{i + 1}. {f.name}</span><b>{f.reached}</b></div>
            <div className="funnel-track"><div className="funnel-bar" style={{ width: `${Math.max(f.reached ? 1.5 : 0, (f.reached / top) * 100)}%` }} /></div>
            <div className="funnel-sub">
              {t('rHere')} {f.here}
              {prev !== null && prev > 0 && <> · {t('rOfPrev', { p: pct(f.reached, prev) })}</>}
            </div>
          </div>
        );
      })}
      {r.noStage > 0 && <p className="hint">{t('rNoStage', { n: r.noStage })}</p>}
    </div>
  );
}

function Outcome({ r }: { r: Report }) {
  const { t } = useI18n();
  const T = r.totals;
  const total = Math.max(1, T.active);
  const parts = [
    { label: t('rBotOnly'), n: T.botOnly, color: '#0d9488' },
    { label: t('rWithHuman'), n: T.withHuman, color: '#d97706' },
  ];
  const src = Object.entries(r.handoffSources);
  return (
    <div>
      <div className="split-bar" role="img" aria-label={parts.map((p) => `${p.label} ${p.n}`).join(', ')}>
        {parts.filter((p) => p.n > 0).map((p) => <div key={p.label} style={{ width: `${(p.n / total) * 100}%`, background: p.color }} title={`${p.label}: ${p.n}`} />)}
      </div>
      {parts.map((p) => (
        <div key={p.label} className="split-row"><i style={{ background: p.color }} /><span>{p.label}</span><b>{p.n}</b><em>{pct(p.n, T.active)}%</em></div>
      ))}
      <p className="hint" style={{ marginTop: 14 }}>
        {t('rHandoffBy', { n: T.handoffs })}
        {src.length ? src.map(([k, n]) => `${t(k === 'keyword' ? 'src_keyword' : k === 'ai' ? 'src_ai' : 'src_other')} ${n}`).join(' · ') : '–'}
      </p>
    </div>
  );
}
