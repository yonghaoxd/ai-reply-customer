import { useState } from 'react';
import { useI18n } from '../i18n';

export interface Trace {
  type: 'ai' | 'greeting' | 'keyword' | 'error' | 'followup' | 'voice_failed' | 'demo_limit';
  n?: number;
  stage?: string | null;
  model?: string;
  ms?: number;
  rounds?: number;
  usage?: { prompt: number; completion: number };
  kb?: { title: string; score: number; text: string }[];
  tools?: { name: string; args: Record<string, unknown> }[];
  stageFrom?: string | null;
  stageTo?: string | null;
  handoffReason?: string | null;
  media?: string[];
}

/** bot 回复下面的「详情」：这句话是怎么来的。 */
export function TraceToggle({ trace }: { trace: Trace | null | undefined }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!trace) return null;
  return (
    <>
      <button className="trace-btn" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} {t('details')}</button>
      {open && (
        <div className="trace-box">
          {trace.type === 'greeting' && <div>{t('traceGreeting')}</div>}
          {trace.type === 'keyword' && <div>{t('traceKeyword')}</div>}
          {trace.type === 'followup' && <div>{t('traceFollowUp', { n: trace.n ?? 1 })}{trace.stage ? ` · ${t('traceStage')} ${trace.stage}` : ''}</div>}
          {trace.type === 'voice_failed' && <div>{t('traceVoiceFailed')}</div>}
          {trace.type === 'demo_limit' && <div>{t('traceDemoLimit')}</div>}
          {trace.handoffReason && <div><b>{t('handoffReason')}</b>{trace.handoffReason}</div>}
          {trace.type === 'ai' && (
            <>
              <div><b>{t('traceModel')}</b>{trace.model} · <b>{t('traceTime')}</b>{((trace.ms ?? 0) / 1000).toFixed(1)}s · <b>{t('traceRounds')}</b>{trace.rounds}</div>
              <div><b>{t('traceTokens')}</b>{trace.usage?.prompt ?? 0} / {trace.usage?.completion ?? 0}</div>
              {trace.stageTo && (
                <div><b>{t('traceStage')}</b>{trace.stageFrom && trace.stageFrom !== trace.stageTo ? `${trace.stageFrom} → ${trace.stageTo}` : trace.stageTo}</div>
              )}
              {!!trace.tools?.length && (
                <div>
                  <b>{t('toolsUsed')}</b>
                  {trace.tools.map((x, i) => <code key={i} className="trace-tool">{x.name}({JSON.stringify(x.args)})</code>)}
                </div>
              )}
              <div>
                <b>{t('kbUsed')}</b>
                {trace.kb?.length ? '' : t('traceNoKb')}
              </div>
              {trace.kb?.map((k, i) => (
                <details key={i} className="trace-kb">
                  <summary>{k.title} <span className="badge">{k.score}</span></summary>
                  <div>{k.text}</div>
                </details>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}
