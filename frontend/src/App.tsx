import { useEffect, useState } from 'react';
import { AddDialog } from './components/AddDialog';
import { Icon } from './components/Icon';
import { filterLabels, Sidebar } from './components/Sidebar';
import { TaskList } from './components/TaskList';
import { useWailsEvents } from './hooks/useWailsEvents';
import { api } from './lib/api';
import { errorMessage, formatSpeed } from './lib/format';
import type { Filter } from './lib/types';
import { useTaskStore } from './store/tasks';

export default function App() {
  const [filter, setFilter] = useState<Filter>('all');
  const [addOpen, setAddOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [cancelingAll, setCancelingAll] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const connection = useTaskStore((state) => state.connection);
  const connectionError = useTaskStore((state) => state.connectionError);
  const stats = useTaskStore((state) => state.stats);
  const ids = useTaskStore((state) => state.filterIDs);
  const connected = connection === 'connected';
  useWailsEvents(attempt);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        if (connected) setAddOpen(true);
      }
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [connected]);

  async function cancelAll() {
    if (cancelingAll || !connected) return;
    setCancelingAll(true);
    setNotice(null);
    try {
      await api.cancelAll();
      setNotice({ message: 'Đã gửi yêu cầu hủy tất cả tác vụ đang tải và chờ tải.', error: false });
    } catch (error) { setNotice({ message: errorMessage(error), error: true }); }
    finally { setCancelingAll(false); }
  }

  return (
    <div className="app-shell font-sans antialiased">
      <a href="#main" className="skip-link">Đến nội dung chính</a>
      <Sidebar filter={filter} onFilter={setFilter} />
      <div className="workspace">
        <header className="topbar"><span className="topbar-label"><span className="tiny-brand-mark" />TRÌNH QUẢN LÝ TẢI XUỐNG</span><span className={`connection-pill connection-${connection}`} role="status"><span className="connection-dot" />{connected ? 'Đã kết nối' : connection === 'connecting' ? 'Đang kết nối' : 'Chưa kết nối'}</span></header>
        <main id="main" className="workspace-main" tabIndex={-1}>
          <section className="page-heading" aria-labelledby="page-title">
            <div><p className="eyebrow">ÍT THAO TÁC HƠN. NHIỀU ĐIỀU HƠN.</p><h1 id="page-title">Mọi tệp. <span>Một nơi.</span></h1><p className="page-description">Những gì bạn cần, trên máy của bạn.</p></div>
            <div className="toolbar" aria-label="Thao tác tải xuống"><button type="button" className="button button-primary add-button" aria-keyshortcuts="Control+N Meta+N" onClick={() => setAddOpen(true)} disabled={!connected}><Icon name="plus" size={19} />Thêm URL<kbd aria-hidden="true">Ctrl N</kbd></button><button type="button" className="button button-outline" onClick={() => { void cancelAll(); }} disabled={!connected || !ids.downloading.length || cancelingAll}>{cancelingAll ? <span className="spinner" /> : <Icon name="stop" size={17} />}{cancelingAll ? 'Đang hủy…' : 'Hủy tất cả'}</button></div>
          </section>
          {connectionError && <div className="connection-error" role="alert"><Icon name="alert" size={20} /><div><strong>Không thể kết nối với GoGet</strong><p>{connectionError}</p>{ids.all.length > 0 && <p>Dữ liệu bên dưới thuộc lần đồng bộ trước.</p>}</div><button type="button" className="button button-small button-outline" onClick={() => setAttempt((value) => value + 1)}><Icon name="refresh" size={15} />Thử lại</button></div>}
          {notice && <div className={`notice ${notice.error ? 'notice-error' : 'notice-success'}`} role={notice.error ? 'alert' : 'status'}><Icon name={notice.error ? 'alert' : 'check'} size={18} /><span>{notice.message}</span><button type="button" className="icon-button" aria-label="Đóng thông báo" onClick={() => setNotice(null)}><Icon name="close" size={16} /></button></div>}
          <section className="metrics" aria-label="Tổng quan tải xuống">
            <div className="metric metric-speed"><div><p>TỔNG TỐC ĐỘ</p><strong>{connected ? stats.globalSpeed > 0 || stats.active === 0 ? formatSpeed(stats.globalSpeed) : '—' : '—'}</strong><span>{connected && stats.active > 0 && stats.globalSpeed === 0 ? 'Chưa có dữ liệu tốc độ' : 'Luồng tải hiện tại'}</span></div><span className="metric-icon"><Icon name="download" size={24} /></span></div>
            <div className="metric"><div><p>ĐANG TẢI</p><strong>{connected ? stats.active : '—'}<small> tệp</small></strong><span>Đang được xử lý</span></div><span className="metric-icon"><Icon name="arrow" size={24} /></span></div>
            <div className="metric"><div><p>HÀNG ĐỢI</p><strong>{connected ? stats.queued : '—'}<small> tệp</small></strong><span>Sẵn sàng đến lượt</span></div><span className="metric-icon"><Icon name="clock" size={23} /></span></div>
          </section>
          <section className="library-panel" aria-labelledby="library-title" aria-busy={connection === 'connecting'}>
            <div className="library-heading"><div><h2 id="library-title">{filterLabels[filter]} lượt tải</h2><span className="library-count">{ids[filter].length}</span></div><span className="sort-description">Mới nhất trước<Icon name="download" size={13} /></span></div>
            <div className="list-columns" aria-hidden="true"><span>TỆP & TIẾN TRÌNH</span><span>THAO TÁC</span></div>
            <TaskList key={filter} filter={filter} onAdd={() => setAddOpen(true)} />
          </section>
        </main>
        <footer className="statusbar"><span><span className={`footer-dot ${connected ? 'is-connected' : ''}`} />{connected ? ids.downloading.length ? `${ids.downloading.length} tác vụ đang hoạt động` : 'Sẵn sàng cho lượt tải mới' : connection === 'connecting' ? 'Đang đồng bộ với ứng dụng…' : 'Đang chờ kết nối với ứng dụng'}</span><span><Icon name="folder" size={14} />Lưu trực tiếp trên thiết bị</span></footer>
      </div>
      <AddDialog open={addOpen} onClose={() => setAddOpen(false)} onAdded={(count) => setNotice({ message: `Đã thêm ${count} tác vụ vào hàng đợi.`, error: false })} />
    </div>
  );
}
