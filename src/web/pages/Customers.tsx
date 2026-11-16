import { useEffect, useState } from 'react';
import { api, fmtTime } from '../api';
import { useI18n } from '../i18n';
import { CustomerPanel, type Customer } from './Inbox';
import type { Stage } from './Sop';

export function Customers({ go }: { go: (p: string) => void }) {
  const { t, lang } = useI18n();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [allTags, setAllTags] = useState<string[]>([]);
  const [list, setList] = useState<Customer[] | null>(null);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);

  const load = () =>
    api<{ customers: Customer[] }>(`/customers?q=${encodeURIComponent(q)}&tag=${encodeURIComponent(tag)}`).then((r) => {
      setList(r.customers);
      if (selected) setSelected(r.customers.find((c) => c.id === selected.id) ?? null);
    });
  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [q, tag]);
  useEffect(() => {
    api<{ tags: string[] }>('/tags').then((r) => setAllTags(r.tags));
    api<{ stages: Stage[] }>('/sop').then((r) => setStages(r.stages));
  }, []);

  return (
    <div className="page" style={{ maxWidth: 1300 }}>
      <div className="page-head"><h1>{t('navCustomers')}</h1></div>
      <div className="row" style={{ marginBottom: 14 }}>
        <input className="grow" placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <select style={{ width: 200 }} value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">{t('tags')}: {t('filterAll')}</option>
          {allTags.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 300px' : '1fr', gap: 16, alignItems: 'start' }}>
        <table className="list">
          <thead>
            <tr><th>{t('name')}</th><th>{t('currentStage')}</th><th>{t('tags')}</th><th>{t('summary')}</th><th>{t('lastMessage')}</th><th /></tr>
          </thead>
          <tbody>
            {list?.map((c) => (
              <tr key={c.id} onClick={() => setSelected(c)} style={{ cursor: 'pointer', background: selected?.id === c.id ? 'var(--accent-soft)' : undefined }}>
                <td style={{ fontWeight: 600 }}>{c.name || c.psid}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{stages.find((st) => st.id === c.stageId)?.name ?? '-'}</td>
                <td>{c.tags.map((x) => <span key={x} className="badge accent" style={{ marginRight: 4 }}>{x}</span>)}</td>
                <td style={{ color: 'var(--muted)', maxWidth: 360 }}>{c.summary || c.notes}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(c.lastMessageAt, lang)}</td>
                <td><button className="small" onClick={(e) => { e.stopPropagation(); go('inbox/' + c.id); }}>{t('openChat')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {selected && (
          <div className="card" style={{ padding: 0 }}>
            <CustomerPanel customer={selected} stages={stages} onSaved={load} />
          </div>
        )}
      </div>
      {list?.length === 0 && <div className="empty">{t('noConversations')}</div>}
    </div>
  );
}
