import { useEffect, useState } from 'react';
import { api, del, fmtSize, patch, post, uploadMedia, type Media } from '../api';
import { useI18n } from '../i18n';
import { MediaThumb } from '../components/MediaThumb';

interface Product {
  id: string;
  name: string;
  category: string;
  price: string | null;
  audience: string;
  description: string;
  selling_points: string;
  specs: string;
  faq: string;
  link_url: string;
  enabled: number;
  sort_order: number;
}

const blank = { name: '', category: '', price: '', audience: '', description: '', sellingPoints: '', specs: '', faq: '', linkUrl: '', enabled: true };
type Draft = typeof blank;

const toDraft = (p: Product): Draft => ({
  name: p.name,
  category: p.category,
  price: p.price ?? '',
  audience: p.audience,
  description: p.description,
  sellingPoints: p.selling_points,
  specs: p.specs,
  faq: p.faq,
  linkUrl: p.link_url,
  enabled: !!p.enabled,
});

export function Products() {
  const { t } = useI18n();
  const [list, setList] = useState<Product[] | null>(null);
  const [media, setMedia] = useState<Media[]>([]);
  const [editing, setEditing] = useState<string | null>(null); // id 或 'new'
  const [draft, setDraft] = useState<Draft>(blank);
  const [err, setErr] = useState('');

  const load = () => {
    api<{ products: Product[] }>('/products').then((r) => setList(r.products));
    api<{ media: Media[] }>('/media').then((r) => setMedia(r.media));
  };
  useEffect(load, []);

  const save = async () => {
    setErr('');
    try {
      if (editing === 'new') await post('/products', draft);
      else await patch(`/products/${editing}`, draft);
      setEditing(null);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const move = async (p: Product, dir: -1 | 1) => {
    if (!list) return;
    const i = list.findIndex((x) => x.id === p.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const other = list[j];
    await patch(`/products/${p.id}`, { sortOrder: j });
    await patch(`/products/${other.id}`, { sortOrder: i });
    load();
  };

  const field = (k: keyof Draft, label: Parameters<typeof t>[0], multiline = false, placeholder = '') => (
    <label className="field">
      <span>{t(label)}</span>
      {multiline ? (
        <textarea value={draft[k] as string} placeholder={placeholder} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
      ) : (
        <input value={draft[k] as string} placeholder={placeholder} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
      )}
    </label>
  );

  const form = (
    <div className="card">
      <div className="grid2">
        {field('name', 'productName')}
        {field('category', 'category')}
        {field('price', 'price', false, t('priceHint'))}
        {field('linkUrl', 'linkUrl')}
      </div>
      {field('audience', 'audience')}
      {field('description', 'description', true)}
      {field('sellingPoints', 'sellingPoints', true)}
      {field('specs', 'specs', true)}
      {field('faq', 'faq', true, 'Q：…\nA：…')}
      <label className="check"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> {t('enabled')}</label>
      {err && <div className="error">{err}</div>}
      <div className="row">
        <button className="primary" onClick={save}>{t('save')}</button>
        <button onClick={() => setEditing(null)}>{t('cancel')}</button>
      </div>
    </div>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('navProducts')}</h1>
          <p className="hint">{t('productHint')}</p>
        </div>
        <button className="primary" onClick={() => { setDraft(blank); setEditing('new'); }}>{t('newProduct')}</button>
      </div>
      {editing === 'new' && form}
      {list?.map((p, i) =>
        editing === p.id ? (
          <div key={p.id}>{form}</div>
        ) : (
          <div key={p.id} className="card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div className="grow">
                <h2 style={{ marginBottom: 6 }}>
                  {p.name} {p.category && <span className="badge">{p.category}</span>} {!p.enabled && <span className="badge">{t('disabled')}</span>}
                </h2>
                <div className="kv"><b>{t('price')}</b>{p.price || <span className="badge warn">{t('priceHint')}</span>}</div>
                <div className="kv"><b>{t('linkUrl')}</b>{p.link_url ? <a href={p.link_url} target="_blank" rel="noreferrer">{p.link_url}</a> : '-'}</div>
                {p.audience && <div className="kv"><b>{t('audience')}</b>{p.audience}</div>}
                <div className="kv" style={{ whiteSpace: 'pre-wrap' }}><b>{t('description')}</b>{p.description || '-'}</div>
                {p.selling_points && <div className="kv" style={{ whiteSpace: 'pre-wrap' }}><b>{t('sellingPoints')}</b>{p.selling_points}</div>}
              </div>
              <div className="row">
                <button className="small" disabled={i === 0} onClick={() => move(p, -1)}>↑</button>
                <button className="small" disabled={i === list.length - 1} onClick={() => move(p, 1)}>↓</button>
                <button className="small" onClick={() => { setDraft(toDraft(p)); setEditing(p.id); }}>{t('edit')}</button>
                <button className="small danger" onClick={async () => { if (confirm(t('confirmDelete'))) { await del(`/products/${p.id}`); load(); } }}>{t('delete')}</button>
              </div>
            </div>
            <MediaManager productId={p.id} media={media.filter((m) => m.productId === p.id)} reload={load} />
          </div>
        ),
      )}
      <div className="card">
        <h2>{t('generalMedia')}</h2>
        <MediaManager productId={null} media={media.filter((m) => !m.productId)} reload={load} />
      </div>
    </div>
  );
}

function MediaManager({ productId, media, reload }: { productId: string | null; media: Media[]; reload: () => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr('');
    setBusy(true);
    try {
      for (const f of Array.from(files)) await uploadMedia(f, productId, title || f.name.replace(/\.[^.]+$/, ''));
      setTitle('');
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <h3>{t('media')}</h3>
      {media.length === 0 && <p className="hint">{t('noMedia')}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10 }}>
        {media.map((m) => (
          <div key={m.id} style={{ width: 150 }}>
            <a href={m.url} target="_blank" rel="noreferrer"><MediaThumb m={m} size={150} /></a>
            <input
              defaultValue={m.title}
              placeholder={t('mediaTitle')}
              style={{ marginTop: 6, fontSize: 12, padding: '4px 6px' }}
              onBlur={async (e) => { if (e.target.value !== m.title) { await patch(`/media/${m.id}`, { title: e.target.value }); reload(); } }}
            />
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
              <span className="hint" style={{ margin: 0 }}>{m.kind === 'video' ? '🎬' : '🖼'} {fmtSize(m.size)}</span>
              <button className="small danger" onClick={async () => { if (confirm(t('confirmDelete'))) { await del(`/media/${m.id}`); reload(); } }}>{t('delete')}</button>
            </div>
          </div>
        ))}
      </div>
      <div className="row">
        <input className="grow" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('mediaTitle')} />
        <label className="btn" style={{ opacity: busy ? 0.6 : 1 }}>
          {busy ? t('uploading') : t('uploadMedia')}
          <input type="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4" multiple disabled={busy} style={{ display: 'none' }} onChange={(e) => { const f = e.target.files; upload(f).finally(() => (e.target.value = '')); }} />
        </label>
      </div>
      <p className="hint">{t('mediaHint')}</p>
      {err && <div className="error">{err}</div>}
    </div>
  );
}
