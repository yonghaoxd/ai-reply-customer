import { useEffect, useState } from 'react';
import { api, del, fmtTime, patch, post } from '../api';
import { useI18n } from '../i18n';

interface Doc {
  id: string;
  title: string;
  source_type: 'text' | 'pdf' | 'docx';
  enabled: number;
  status: string;
  error: string | null;
  chunk_count: number;
  chars: number;
  created_at: number;
}

/** 在浏览器里把 PDF / Word 变成文字（不上传原件，避开免费版 CPU 限制）。 */
async function extractText(file: File): Promise<{ text: string; type: 'pdf' | 'docx' }> {
  const buf = await file.arrayBuffer();
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) {
    const pdfjs = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        line += item.str ?? '';
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join('\n'));
    }
    return { text: pages.join('\n\n'), type: 'pdf' };
  }
  if (name.endsWith('.docx')) {
    const mammoth: any = await import('mammoth/mammoth.browser.js');
    const r = await (mammoth.default ?? mammoth).extractRawText({ arrayBuffer: buf });
    return { text: r.value as string, type: 'docx' };
  }
  throw new Error('只支持 .pdf 和 .docx（旧的 .doc 请先另存为 .docx）');
}

export function Knowledge() {
  const { t, lang } = useI18n();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [mode, setMode] = useState<'none' | 'text' | 'edit'>('none');
  const [editId, setEditId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = () => api<{ documents: Doc[] }>('/kb').then((r) => setDocs(r.documents));
  useEffect(() => {
    load();
  }, []);

  const saveText = async () => {
    setErr('');
    setBusy(t('indexing'));
    try {
      if (mode === 'edit' && editId) await patch(`/kb/${editId}`, { title, content });
      else await post('/kb', { title, content, sourceType: 'text' });
      setMode('none');
      setTitle('');
      setContent('');
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const upload = async (file: File) => {
    setErr('');
    try {
      setBusy(t('reading'));
      const { text, type } = await extractText(file);
      if (!text.trim()) throw new Error('这个文件读不到文字（可能是扫描版 PDF）');
      setBusy(t('indexing'));
      await post('/kb', { title: file.name.replace(/\.(pdf|docx)$/i, ''), content: text, sourceType: type });
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const openEdit = async (d: Doc) => {
    const r = await api<{ document: { title: string; content: string } }>(`/kb/${d.id}`);
    setTitle(r.document.title);
    setContent(r.document.content);
    setEditId(d.id);
    setMode('edit');
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('navKb')}</h1>
          <p className="hint">{t('kbHint')}</p>
        </div>
        <div className="row">
          <button onClick={() => { setTitle(''); setContent(''); setMode('text'); }}>{t('pasteText')}</button>
          <label className="btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}>
            {t('uploadFile')}
            <input type="file" accept=".pdf,.docx" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} />
          </label>
        </div>
      </div>
      {busy && <div className="card">{busy}</div>}
      {err && <div className="error">{err}</div>}
      {mode !== 'none' && (
        <div className="card">
          <label className="field"><span>{t('title')}</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：常见问题、课程详情、付款方式" /></label>
          <label className="field"><span>{t('content')}</span><textarea value={content} onChange={(e) => setContent(e.target.value)} style={{ minHeight: 260 }} /></label>
          <div className="row">
            <button className="primary" onClick={saveText} disabled={!!busy || !content.trim()}>{t('save')}</button>
            <button onClick={() => setMode('none')}>{t('cancel')}</button>
            <span className="hint">{content.length.toLocaleString()} {t('chars')}</span>
          </div>
        </div>
      )}
      <table className="list">
        <thead>
          <tr><th>{t('title')}</th><th /><th>{t('content')}</th><th>{t('createdAt')}</th><th>{t('enabled')}</th><th /></tr>
        </thead>
        <tbody>
          {docs?.map((d) => (
            <tr key={d.id}>
              <td style={{ fontWeight: 600 }}>
                {d.title}
                {d.error && <div className="hint" style={{ color: 'var(--warn)' }}>{d.error}</div>}
              </td>
              <td><span className="badge">{d.source_type.toUpperCase()}</span></td>
              <td style={{ whiteSpace: 'nowrap' }}>{d.chars.toLocaleString()} {t('chars')} · {d.chunk_count} {t('chunks')}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(d.created_at, lang)}</td>
              <td><input type="checkbox" style={{ width: 'auto' }} checked={!!d.enabled} onChange={async (e) => { await patch(`/kb/${d.id}`, { enabled: e.target.checked }); load(); }} /></td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="small" onClick={() => openEdit(d)}>{t('edit')}</button>{' '}
                <button className="small" onClick={async () => { setBusy(t('indexing')); await post(`/kb/${d.id}/reindex`).catch((e) => setErr(e.message)); setBusy(''); load(); }}>{t('reindex')}</button>{' '}
                <button className="small danger" onClick={async () => { if (confirm(t('confirmDelete'))) { await del(`/kb/${d.id}`); load(); } }}>{t('delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {docs?.length === 0 && <div className="empty">{t('noDocs')}</div>}
    </div>
  );
}
