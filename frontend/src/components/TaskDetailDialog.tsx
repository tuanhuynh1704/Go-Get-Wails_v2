import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { errorMessage, formatBytes, formatETA, formatSpeed, percent } from '../lib/format';
import { statusLabels, type TaskDetail } from '../lib/types';
import { useTaskStore } from '../store/tasks';
import { Icon } from './Icon';
import { SegmentBar } from './SegmentBar';

const segmentLabels: Record<string, string> = { queued: 'Chờ tải', pending: 'Chờ tải', downloading: 'Đang tải', completed: 'Hoàn tất', failed: 'Thất bại', canceled: 'Đã hủy' };

export function TaskDetailDialog({ id, onClose }: { id: string | null; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const task = useTaskStore((state) => id ? state.tasks[id] : undefined);
  const connected = useTaskStore((state) => state.connection === 'connected');
  const status = task?.status;
  const [attempt, setAttempt] = useState(0);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!id || !dialog.current) return;
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousRegion = previousFocus?.closest<HTMLElement>('[role="region"]');
    element.showModal();
    element.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      element.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      else if (previousRegion?.isConnected && previousRegion.getAttribute('role') === 'region') previousRegion.focus({ preventScroll: true });
      else document.getElementById('main')?.focus({ preventScroll: true });
    };
  }, [id]);

  useEffect(() => {
    let current = true;
    setDetail(null);
    setError(null);
    setLoading(false);
    if (!id) return;
    if (!connected) { setError('Mất kết nối với ứng dụng. Hãy kết nối lại để xem chi tiết.'); return; }
    setLoading(true);
    void api.getTaskDetail(id).then((result) => {
      if (!current) return;
      if (result.task.id !== id) { setError('Chi tiết tác vụ không khớp với yêu cầu.'); return; }
      setDetail(result);
    }).catch((reason: unknown) => { if (current) setError(errorMessage(reason)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [id, status, connected, attempt]);

  const fileName = task?.fileName || detail?.task.fileName || 'Tác vụ tải xuống';
  return <dialog ref={dialog} className="add-dialog task-detail-dialog" aria-labelledby="detail-title" aria-describedby="detail-description"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const controls = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <div className="dialog-heading"><span className="dialog-symbol"><Icon name="file" size={24} /></span><button type="button" className="icon-button" aria-label="Đóng chi tiết" onClick={onClose}><Icon name="close" /></button></div>
    <h2 id="detail-title">Chi tiết tải xuống</h2>
    <p id="detail-description" className="detail-file-name" dir="auto">{fileName}</p>
    <div aria-busy={loading} className="detail-body">
      {loading && <p role="status" className="detail-state"><span className="spinner" />Đang tải chi tiết…</p>}
      {error && <p role="alert" className="form-errors">{error}</p>}
      {detail && <>
        <dl className="detail-summary"><div><dt>Trạng thái</dt><dd>{statusLabels[detail.task.status]}</dd></div><div><dt>Dung lượng</dt><dd>{formatBytes(detail.task.done)} / {formatBytes(detail.task.total)}</dd></div><div><dt>Tốc độ</dt><dd>{formatSpeed(detail.task.speed)}</dd></div><div><dt>ETA</dt><dd>{formatETA(detail.task.etaSec)}</dd></div></dl>
        <h3 className="detail-segments-title">Các đoạn tải <span>({detail.segments.length})</span></h3>
        <SegmentBar segs={detail.task.segs} fileName={fileName} />
        {detail.segments.length === 0 ? <p className="detail-state">Chưa có dữ liệu đoạn tải. Tác vụ có thể đang chờ hoặc kết nối.</p> : <div className="segment-details">
          {detail.segments.map((segment) => {
            const size = segment.end >= segment.start ? segment.end - segment.start + 1 : -1;
            const progress = percent(segment.done, size);
            return <div key={segment.index} className="segment-detail" role="group" aria-label={`Chi tiết đoạn ${segment.index + 1}`}>
              <strong>Đoạn {segment.index + 1}</strong><span className="segment-range">Byte {segment.start.toLocaleString('vi-VN')} – {size < 0 ? 'chưa rõ' : segment.end.toLocaleString('vi-VN')}</span>
              <span>{formatBytes(segment.done)} / {formatBytes(size)}{progress === undefined ? '' : ` · ${progress}%`}</span><span>{segmentLabels[segment.status] || segment.status}</span>
            </div>;
          })}
        </div>}
        <p className="field-hint">Mốc byte cuối được tính trong đoạn. Chi tiết cập nhật khi mở, đổi trạng thái hoặc làm mới.</p>
      </>}
    </div>
    <div className="dialog-footer"><span className="dialog-footnote">Dữ liệu từ ứng dụng GoGet</span><div className="dialog-actions"><button type="button" className="button button-outline" disabled={loading || !connected} onClick={() => setAttempt((value) => value + 1)}><Icon name="refresh" size={15} />Làm mới</button><button type="button" className="button button-primary" onClick={onClose}>Đóng</button></div></div>
  </dialog>;
}
