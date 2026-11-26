import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { Filter } from '../lib/types';
import { useTaskStore } from '../store/tasks';
import { Icon } from './Icon';
import { TaskRow } from './TaskRow';

const emptyCopy: Record<Filter, { title: string; detail: string }> = {
  all: { title: 'Bắt đầu với một đường dẫn.', detail: 'Thêm URL đầu tiên. Các tệp của bạn sẽ được sắp xếp gọn gàng tại đây.' },
  downloading: { title: 'Hàng đợi đang thảnh thơi.', detail: 'Không có tệp nào đang tải hoặc chờ tải. Sẵn sàng cho đường dẫn tiếp theo.' },
  completed: { title: 'Những tệp hoàn tất sẽ ở đây.', detail: 'Khi tải xong, GoGet sẽ tự cập nhật trạng thái cho bạn.' },
  failed: { title: 'Không có tác vụ thất bại.', detail: 'Nếu một lượt tải gặp lỗi, thông tin chi tiết sẽ xuất hiện tại đây.' },
};

function EmptyIllustration() {
  return <div className="empty-art" aria-hidden="true"><span className="empty-orbit orbit-one" /><span className="empty-orbit orbit-two" /><span className="art-spark spark-one" /><span className="art-spark spark-two" /><div className="empty-file"><span /><span /><span /></div><div className="empty-tray"><Icon name="download" size={37} /></div><span className="art-check"><Icon name="check" size={13} /></span></div>;
}

export function TaskList({ filter, onAdd }: { filter: Filter; onAdd(): void }) {
  const ids = useTaskStore((state) => state.filterIDs[filter]);
  const connection = useTaskStore((state) => state.connection);
  const scroll = useRef<HTMLDivElement>(null);
  const [focusedID, setFocusedID] = useState<string | null>(null);
  const pendingFocus = useRef(false);
  const focusedIndex = focusedID === null ? -1 : ids.indexOf(focusedID);
  const virtual = ids.length >= 100;
  const getItemKey = useCallback((index: number) => ids[index], [ids]);
  // Keep a focused row mounted when the user scrolls, preserving keyboard focus.
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range);
    if (focusedIndex >= 0 && !indexes.includes(focusedIndex)) indexes.push(focusedIndex);
    return indexes.sort((a, b) => a - b);
  }, [focusedIndex, ids.length]);
  const virtualizer = useVirtualizer({
    count: ids.length, getScrollElement: () => scroll.current, getItemKey,
    estimateSize: () => 154, overscan: 5, enabled: virtual, rangeExtractor,
  });

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const row = scroll.current?.querySelector<HTMLElement>(`[data-index="${focusedIndex}"]`);
    if (row) {
      pendingFocus.current = false;
      row.focus({ preventScroll: true });
      if (!virtual) row.scrollIntoView?.({ block: 'nearest' });
    }
  });

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let index: number;
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = ids.length - 1;
    else if (event.key === 'ArrowDown') index = Math.min(focusedIndex + 1, ids.length - 1);
    else if (event.key === 'ArrowUp') index = Math.max(0, focusedIndex - 1);
    else return;
    event.preventDefault();
    const row = scroll.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (virtual) virtualizer.scrollToIndex(index, { align: 'auto' });
    if (row) {
      row.focus({ preventScroll: true });
      if (!virtual) row.scrollIntoView?.({ block: 'nearest' });
    } else pendingFocus.current = true;
    setFocusedID(ids[index]);
  }

  if (connection === 'connecting' && ids.length === 0) return <div className="list-state" role="status"><span className="loading-ring" /><h2>Đang đồng bộ thư viện</h2><p className="muted">Kết nối với GoGet để lấy các lượt tải của bạn…</p></div>;
  if (connection === 'error' && ids.length === 0) return <div className="list-state offline-state"><div className="offline-icon"><Icon name="link" size={30} /></div><h2>Thư viện đang ngoại tuyến</h2><p className="muted">Kết nối lại với ứng dụng để xem và quản lý tải xuống.</p></div>;
  if (ids.length === 0) return <div className="list-state empty-state"><EmptyIllustration /><span className="eyebrow">KHÔNG GIAN CHO ĐIỀU TIẾP THEO</span><h2>{emptyCopy[filter].title}</h2><p className="muted">{emptyCopy[filter].detail}</p><button type="button" className="button button-primary" onClick={onAdd} disabled={connection !== 'connected'}><Icon name="plus" size={18} />Thêm URL{filter === 'all' ? ' đầu tiên' : ' mới'}</button>{filter === 'all' && <div className="empty-steps"><span><b>01</b> Dán đường dẫn</span><span><b>02</b> Chọn thư mục</span><span><b>03</b> Bắt đầu tải</span></div>}</div>;

  return <div ref={scroll} className="task-scroll" tabIndex={0} role="region" aria-label="Danh sách tải xuống" aria-describedby="task-keyboard-hint" onKeyDown={navigate} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedID(null); }}>
    <p id="task-keyboard-hint" className="sr-only">Dùng phím mũi tên lên, xuống để chuyển tác vụ. Home đến đầu, End đến cuối danh sách. Tab đến nút hủy.</p>
    <div role="list" aria-label="Các tác vụ" className={virtual ? 'virtual-list' : 'task-list'} style={virtual ? { height: virtualizer.getTotalSize() } : undefined}>
      {virtual ? virtualizer.getVirtualItems().map((item) => <div key={item.key} role="listitem" tabIndex={-1} aria-posinset={item.index + 1} aria-setsize={ids.length} className="virtual-row" data-index={item.index} ref={virtualizer.measureElement} style={{ transform: `translateY(${item.start}px)` }} onFocusCapture={() => setFocusedID(ids[item.index])}><TaskRow id={ids[item.index]} /></div>) : ids.map((id, index) => <div key={id} role="listitem" tabIndex={-1} data-index={index} onFocusCapture={() => setFocusedID(id)}><TaskRow id={id} /></div>)}
    </div>
  </div>;
}
