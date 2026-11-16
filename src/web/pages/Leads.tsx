import { useEffect, useState } from 'react';
import { api, del, fmtTime, patch, post } from '../api';
import { useI18n } from '../i18n';

interface Lead {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  name: string;
  phone: string;
  email: string;
  interest: string;
  status: 'new' | 'contacted' | 'enrolled' | 'lost';
  created_at: number;
}

const STATUSES = ['new', 'contacted', 'enrolled', 'lost'] as const;

export function Leads({ go }: { go: (p: string) => void }) {
  const { t, lang } = useI18n();
  const [status, setStatus] = useState('');
  const [list, setList] = useState<Lead[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', phone: '', email: '', interest: '' });

  const load = () => api<{ leads: Lead[] }>(`/leads${status ? '?status=' + status : ''}`).then((r) => setList(r.leads));
  useEffect(() => {
    load();
  }, [status]);

  const update = async (l: Lead, field: keyof Lead, value: string) => {
    if ((l[field] ?? '') === value) return;
    await patch(`/leads/${l.id}`, { [field]: value });
    load();
  };

  return (
    <div className="page" style={{ maxWidth: 1300 }}>
      <div className="page-head">
        <h1>{t('navLeads')}</h1>
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 160 }}>
            <option value="">{t('status')}: {t('filterAll')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`lead_${s}`)}</option>)}
          </select>
          <a className="btn" href="/api/leads.csv">{t('exportCsv')}</a>
          <button className="primary" onClick={() => setAdding(true)}>{t('add')}</button>
        </div>
      </div>
      {adding && (
        <div className="card">
          <div className="grid2">
            {(['name', 'phone', 'email', 'interest'] as const).map((k) => (
              <label key={k} className="field"><span>{t(k)}</span><input value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></label>
            ))}
          </div>
          <div className="row">
            <button className="primary" onClick={async () => { await post('/leads', draft); setDraft({ name: '', phone: '', email: '', interest: '' }); setAdding(false); load(); }}>{t('save')}</button>
            <button onClick={() => setAdding(false)}>{t('cancel')}</button>
          </div>
        </div>
      )}
      <table className="list">
        <thead>
          <tr><th>{t('name')}</th><th>{t('phone')}</th><th>{t('email')}</th><th>{t('interest')}</th><th>{t('status')}</th><th>{t('createdAt')}</th><th /></tr>
        </thead>
        <tbody>
          {list?.map((l) => (
            <tr key={l.id}>
              {(['name', 'phone', 'email', 'interest'] as const).map((k) => (
                <td key={k}><input defaultValue={l[k]} onBlur={(e) => update(l, k, e.target.value)} /></td>
              ))}
              <td>
                <select value={l.status} onChange={(e) => update(l, 'status', e.target.value)}>
                  {STATUSES.map((s) => <option key={s} value={s}>{t(`lead_${s}`)}</option>)}
                </select>
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(l.created_at, lang)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {l.customer_id && <button className="small" onClick={() => go('inbox/' + l.customer_id)}>{t('openChat')}</button>}{' '}
                <button className="small danger" onClick={async () => { if (confirm(t('confirmDelete'))) { await del(`/leads/${l.id}`); load(); } }}>{t('delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list?.length === 0 && <div className="empty">{t('noLeads')}</div>}
    </div>
  );
}
