import { memo, useId, useState } from 'react';
import { api } from '../lib/api';
import { errorMessage, formatBytes, formatETA, formatSpeed, percent, sourceHost } from '../lib/format';
import { isTerminal, statusLabels } from '../lib/types';
import { useTaskStore } from '../store/tasks';
import { Icon } from './Icon';

export const TaskRow = memo(function TaskRow({ id }: { id: string }) {
  const task = useTaskStore((state) => state.tasks[id]);
  const connected = useTaskStore((state) => state.connection === 'connected');
  const [canceling, setCanceling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const nameID = useId();
  if (!task) return null;
  const active = !isTerminal(task.status);
  const percentage = task.status === 'completed' ? 100 : percent(task.done, task.total);
  const fileName = task.fileName || 'Đang xác định tên tệp';
  const extension = task.fileName.split('.').pop()?.toUpperCase();
  const kind = task.fileName.includes('.') && extension && /^[A-Z0-9]{1,5}$/.test(extension) ? extension : 'FILE';

  async function cancel() {
    if (canceling || !connected) return;
    setCanceling(true);
    setActionError(null);
    try { await api.cancel(id, false); }
    catch (error) { setActionError(errorMessage(error)); }
    finally { setCanceling(false); }
  }

  return (
    <article className={`task-row task-${task.status}`} aria-labelledby={nameID}>
      <div className={`file-icon file-${kind === 'ZIP' || kind === 'RAR' || kind === '7Z' ? 'archive' : kind === 'PDF' ? 'document' : 'default'}`}><Icon name="file" size={24} /><span>{kind}</span></div>
      <div className="task-content min-w-0">
        <div className="task-title-line"><h3 id={nameID} className="truncate" dir="auto" title={fileName}>{fileName}</h3><span className={`status-badge status-${task.status}`}><span className="status-dot" />{statusLabels[task.status]}</span></div>
        <p className="task-source truncate" title={task.url}><span>{sourceHost(task.url)}</span><span className="source-dot">·</span><span title={task.saveDir}>{task.saveDir || 'Thư mục mặc định'}</span></p>
        <div className="task-progress-line">
          <div className={`progress-track ${percentage === undefined && active ? 'is-indeterminate' : ''}`} role="progressbar" aria-label={`Tiến trình ${fileName}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} aria-valuetext={percentage === undefined ? `${formatBytes(task.done)} đã tải, chưa rõ tổng dung lượng` : `${percentage}%`}>
            <div className="progress-fill" style={{ width: `${percentage ?? (active ? 25 : 0)}%` }} />
          </div>
          <span className="task-percent">{percentage === undefined ? 'Chưa rõ' : `${percentage}%`}</span>
        </div>
        <div className="task-details"><span>{formatBytes(task.done)}<span className="muted"> / {formatBytes(task.total)}</span></span>{active && <span className="task-timing">{task.speed > 0 ? formatSpeed(task.speed) : 'Chờ dữ liệu tốc độ'}<span className="source-dot">·</span>{formatETA(task.etaSec)}</span>}{task.status === 'canceled' && <span className="muted">Tác vụ đã dừng</span>}</div>
        {task.status === 'failed' && <p className="task-error" title={task.error}><Icon name="alert" size={14} /><span>{task.error || 'Không thể hoàn tất tải xuống.'}</span></p>}
        {actionError && <p className="task-error" role="alert">{actionError}</p>}
      </div>
      <div className="task-action">
        {active ? <button type="button" className="icon-button cancel-task" disabled={canceling || !connected} onClick={(event) => { event.currentTarget.closest<HTMLElement>('[role="listitem"]')?.focus({ preventScroll: true }); void cancel(); }} aria-label={`Hủy tải ${fileName}`} title="Hủy tác vụ và xóa phần tệp chưa hoàn tất">{canceling ? <span className="spinner" /> : <Icon name="close" size={18} />}</button> : <span className={`terminal-icon terminal-${task.status}`} aria-hidden="true"><Icon name={task.status === 'completed' ? 'check' : task.status === 'failed' ? 'alert' : 'stop'} size={19} /></span>}
      </div>
    </article>
  );
});
