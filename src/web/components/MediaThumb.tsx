import type { Media } from '../api';

/** 小缩图：图片直接显示，视频显示第一帧 */
export function MediaThumb({ m, size = 72 }: { m: Pick<Media, 'kind' | 'url' | 'title'>; size?: number }) {
  const style = { width: size, height: size, objectFit: 'cover' as const, borderRadius: 8, background: '#e5e7eb', display: 'block' };
  return m.kind === 'image' ? (
    <img src={m.url} alt={m.title} style={style} loading="lazy" />
  ) : (
    <div style={{ position: 'relative', width: size, height: size }}>
      <video src={m.url + '#t=0.1'} style={style} muted preload="metadata" />
      <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff', fontSize: size / 3, textShadow: '0 1px 4px #000' }}>▶</span>
    </div>
  );
}
