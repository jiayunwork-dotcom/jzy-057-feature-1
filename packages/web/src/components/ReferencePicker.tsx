import { useEffect, useState } from 'react';
import { api, type DocSummary, type Excerpt } from '../api/client';

interface Props {
  currentDocId: string;
  onPick: (excerptId: string) => void;
  onClose: () => void;
  onError: (m: string) => void;
}

/**
 * Insert-reference picker: choose any accessible document, then one of its
 * registered excerpts. The server re-checks permissions and cycles at insert
 * time; this dialog only offers what the viewer may see.
 */
export function ReferencePicker({ currentDocId, onPick, onClose, onError }: Props) {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [docId, setDocId] = useState<string>('');
  const [excerpts, setExcerpts] = useState<Excerpt[] | null>(null);

  useEffect(() => {
    api
      .tree()
      .then((t) => {
        setDocs(t.docs);
        const first = t.docs.find((d) => d.id !== currentDocId) ?? t.docs[0];
        if (first) setDocId(first.id);
      })
      .catch((e) => onError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!docId) return;
    setExcerpts(null);
    api
      .excerpts(docId)
      .then((r) => setExcerpts(r.excerpts))
      .catch((e) => onError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 'min(640px, 92vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>插入活引用</h3>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="hint" style={{ marginTop: 0 }}>
            引用块在源码中是一个紧凑标记，预览时渲染为来源片段的当前内容；来源更新后此处会实时跟随。
          </p>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', margin: '8px 0 4px' }}>
            来源文档
          </label>
          <select value={docId} onChange={(e) => setDocId(e.target.value)} style={{ width: '100%' }}>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
                {d.id === currentDocId ? '（当前文档）' : ''}
              </option>
            ))}
          </select>

          <div className="v-list" style={{ marginTop: 12 }}>
            {excerpts === null && <div style={{ color: 'var(--muted)' }}>加载片段…</div>}
            {excerpts !== null && excerpts.length === 0 && (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                该文档还没有已登记的片段。在编辑器中选中一段正文，点击「登记为引用片段」即可创建。
              </div>
            )}
            {(excerpts ?? []).map((e) => (
              <div key={e.id} className="v-row">
                <div className="grow">
                  <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
                    {e.quote.length > 90 ? `${e.quote.slice(0, 90)}…` : e.quote}
                  </div>
                  <small>
                    {e.status === 'invalid' ? '已失效（源内容被删除）' : '锚定中'}
                  </small>
                </div>
                <button className="primary" onClick={() => onPick(e.id)}>
                  插入引用
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
