import { useEffect, useState } from 'react';
import { api, del, patch, post } from '../api';
import { useI18n } from '../i18n';

interface Reply {
  id: string;
  title: string;
  text: string;
}

/** Inbox 的快捷回复：点一下把内容填进输入框（可以改了再发）；也在这里新增、修改、删除。 */
export function QuickReplies({ onPick, onClose }: { onPick: (text: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [list, setList] = useState<Reply[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // id 或 'new'
  const [draft, setDraft] = useState({ title: '', text: '' });
  const [err, setErr] = useState('');

  const load = () => api<{ replies: Reply[] }>('/quick-replies').then((r) => setList(r.replies));
  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    setErr('');
    try {
      if (editing === 'new') await post('/quick-replies', draft);
      else await patch(`/quick-replies/${editing}`, draft);
      setEditing(null);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="card" style={{ marginTop: 10, marginBottom: 0, maxHeight: 300, overflow: 'auto' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <b>{t('quickReplies')}</b>
        <div className="row">
          <button className="small" onClick={() => { setDraft({ title: '', text: '' }); setEditing('new'); }}>+ {t('add')}</button>
          <button className="small" onClick={onClose}>{t('close')}</button>
        </div>
      </div>
      {editing && (
        <div style={{ marginBottom: 10 }}>
          <input value={draft.title} placeholder={t('qrTitle')} onChange={(e) => setDraft({ ...draft, title: e.target.value })} style={{ marginBottom: 6 }} />
          <textarea value={draft.text} placeholder={t('qrText')} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          {err && <div className="error">{err}</div>}
          <div className="row" style={{ marginTop: 6 }}>
            <button className="small primary" onClick={save} disabled={!draft.text.trim()}>{t('save')}</button>
            <button className="small" onClick={() => setEditing(null)}>{t('cancel')}</button>
          </div>
        </div>
      )}
      {list?.length === 0 && !editing && <p className="hint">{t('qrEmpty')}</p>}
      {list?.map((r) => (
        <div key={r.id} className="qr-item">
          <button className="qr-pick" onClick={() => onPick(r.text)} title={r.text}>
            <b>{r.title}</b>
            <span>{r.text}</span>
          </button>
          <button className="small" onClick={() => { setDraft({ title: r.title, text: r.text }); setEditing(r.id); }}>{t('edit')}</button>
          <button className="small danger" onClick={async () => { if (confirm(t('confirmDelete'))) { await del(`/quick-replies/${r.id}`); load(); } }}>{t('delete')}</button>
        </div>
      ))}
    </div>
  );
}
