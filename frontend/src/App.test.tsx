import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { api } from './lib/api';
import { useTaskStore } from './store/tasks';
import { emptyStats, makeTask, settings } from './test/fixtures';
import type { Snapshot } from './lib/types';

vi.mock('./lib/api', () => ({ api: {
  addURLs: vi.fn(), listTasks: vi.fn(), getSettings: vi.fn(), subscribe: vi.fn(),
  cancel: vi.fn(), cancelAll: vi.fn(), pickDirectory: vi.fn(), getTaskDetail: vi.fn(),
} }));

beforeEach(() => {
  vi.resetAllMocks();
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  vi.mocked(api.listTasks).mockResolvedValue({ tasks: [], stats: emptyStats });
  vi.mocked(api.getSettings).mockResolvedValue(settings);
  vi.mocked(api.subscribe).mockReturnValue(vi.fn());
  vi.mocked(api.cancel).mockResolvedValue();
  vi.mocked(api.cancelAll).mockResolvedValue();
});

async function renderReady(snapshot?: Snapshot) {
  if (snapshot) vi.mocked(api.listTasks).mockResolvedValue(snapshot);
  const result = render(<App />);
  await waitFor(() => expect(screen.getByText('Đã kết nối')).toBeInTheDocument());
  return result;
}

describe('GoGet application', () => {
  it('displays real speed, ETA and segment events, and opens detail only on user action', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getTaskDetail).mockResolvedValue({ task: makeTask({ segs: [100, 20] }), segments: [{ index: 0, start: 0, end: 49, done: 50, status: 'completed' }] });
    await renderReady({ tasks: [makeTask({ segs: [20, 40], segCount: 2, speed: 1536, etaSec: 61 })], stats: { active: 1, queued: 2, globalSpeed: 1024 } });
    const row = screen.getByRole('article', { name: 'tài-liệu.pdf' });
    expect(within(row).getByText(/1,5 KB\/s/)).toHaveTextContent('ETA 2 phút');
    expect(within(row).getByRole('group', { name: 'Tiến trình 2 đoạn của tài-liệu.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Tổng: 1 KB/s · Đang tải: 1 · Hàng đợi: 2');
    expect(api.getTaskDetail).not.toHaveBeenCalled();
    act(() => {
      useTaskStore.getState().applyEvent({ type: 'tasks:progress', items: [{ id: 'task-1', done: 60, total: 100, speed: 2048, etaSec: 20, segs: [100, 20] }] });
      useTaskStore.getState().applyEvent({ type: 'stats:update', stats: { active: 1, queued: 2, globalSpeed: 2048 } });
    });
    expect(within(row).getByRole('progressbar', { name: 'Đoạn 1 của tài-liệu.pdf' })).toHaveAttribute('aria-valuenow', '100');
    expect(within(row).getByText(/2 KB\/s/)).toHaveTextContent('ETA 20 giây');
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Tổng: 2 KB/s');
    const trigger = within(row).getByRole('button', { name: 'Chi tiết tải tài-liệu.pdf' });
    await user.click(trigger);
    expect(await screen.findByRole('group', { name: 'Chi tiết đoạn 1' })).toBeInTheDocument();
    expect(api.getTaskDetail).toHaveBeenCalledWith('task-1');
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(trigger).toHaveFocus();
  });
  it('renders actual loading, connected empty and disconnected states with retry', async () => {
    const stop = vi.fn();
    vi.mocked(api.subscribe).mockReturnValue(stop);
    vi.mocked(api.listTasks).mockRejectedValueOnce(new Error('Ứng dụng chưa sẵn sàng'));
    render(<App />);
    expect(screen.getByText('Đang đồng bộ thư viện')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Ứng dụng chưa sẵn sàng');
    expect(screen.getByRole('button', { name: 'Thêm URL' })).toBeDisabled();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText('Bắt đầu với một đường dẫn.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hủy tất cả' })).toBeDisabled();
    expect(stop).toHaveBeenCalled();
  });
  it('restores a stable focus target if a detail task leaves the active filter while open', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getTaskDetail).mockResolvedValue({ task: makeTask(), segments: [] });
    await renderReady({ tasks: [makeTask()], stats: emptyStats });
    await user.click(screen.getByRole('button', { name: /^Đang tải/ }));
    await user.click(screen.getByRole('button', { name: 'Chi tiết tải tài-liệu.pdf' }));
    await screen.findByText(/Chưa có dữ liệu đoạn tải/);
    act(() => useTaskStore.getState().applyEvent({ type: 'task:status', task: makeTask({ status: 'completed', done: 100, segs: [100] }) }));
    await screen.findByText('Hàng đợi đang thảnh thơi.');
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  });

  it('adds from the toolbar and restores focus after native Escape', async () => {
    const user = userEvent.setup();
    await renderReady();
    const trigger = screen.getByRole('button', { name: 'Thêm URL' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('renders safe long filenames, unknown totals and terminal error details', async () => {
    const fileName = '<img src=x onerror=alert(1)>' + 'tài-liệu-'.repeat(30) + '.zip';
    await renderReady({ tasks: [makeTask({ fileName, category: 'archive', total: -1 }), makeTask({ id: 'failed', status: 'failed', error: 'Máy chủ trả về 404', createdAt: 101 })], stats: { active: 1, queued: 0, globalSpeed: 0 } });
    expect(screen.getByRole('heading', { name: fileName })).toHaveAttribute('title', fileName);
    expect(document.querySelector('img')).toBeNull();
    const progress = screen.getByRole('progressbar', { name: `Tiến trình ${fileName}` });
    expect(progress).not.toHaveAttribute('aria-valuenow');
    expect(progress).toHaveAttribute('aria-valuetext', expect.stringContaining('chưa rõ tổng dung lượng'));
    expect(screen.getByText('Máy chủ trả về 404')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tạm dừng|Tiếp tục|Cài đặt/ })).not.toBeInTheDocument();
  });

  it('cancels an individual active task and follows backend terminal events', async () => {
    const user = userEvent.setup();
    await renderReady({ tasks: [makeTask()], stats: { active: 1, queued: 0, globalSpeed: 0 } });
    await user.click(screen.getByRole('button', { name: 'Hủy tải tài-liệu.pdf' }));
    expect(api.cancel).toHaveBeenCalledWith('task-1', false);
    act(() => useTaskStore.getState().applyEvent({ type: 'task:status', task: makeTask({ status: 'canceled' }) }));
    expect(screen.queryByRole('button', { name: 'Hủy tải tài-liệu.pdf' })).not.toBeInTheDocument();
    expect(screen.getByText('Đã hủy')).toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Hủy tất cả' })).toBeDisabled();
  });

  it('shows failures from both individual and global cancellation', async () => {
    const user = userEvent.setup();
    vi.mocked(api.cancel).mockRejectedValue(new Error('Không thể hủy tệp'));
    vi.mocked(api.cancelAll).mockRejectedValue(new Error('Không thể hủy hàng đợi'));
    await renderReady({ tasks: [makeTask()], stats: { active: 1, queued: 0, globalSpeed: 0 } });
    await user.click(screen.getByRole('button', { name: 'Hủy tải tài-liệu.pdf' }));
    expect(await screen.findByText('Không thể hủy tệp')).toHaveAttribute('role', 'alert');
    await user.click(screen.getByRole('button', { name: 'Hủy tất cả' }));
    expect(api.cancelAll).toHaveBeenCalledOnce();
    expect(await screen.findByText('Không thể hủy hàng đợi')).toBeInTheDocument();
  });

  it('filters active/completed/failed tasks and unsubscribes on unmount', async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    vi.mocked(api.subscribe).mockReturnValue(stop);
    const { unmount } = await renderReady({ tasks: [makeTask(), makeTask({ id: 'complete', fileName: 'xong.zip', category: 'archive', status: 'completed', done: 100 }), makeTask({ id: 'failed', fileName: 'loi.zip', category: 'archive', status: 'failed' })], stats: emptyStats });
    await user.click(screen.getByRole('button', { name: /^Hoàn tất/ }));
    expect(screen.getByRole('heading', { name: 'xong.zip' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'loi.zip' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Thất bại/ }));
    expect(screen.getByRole('heading', { name: 'loi.zip' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Đang tải/ }));
    expect(screen.getByRole('heading', { name: 'tài-liệu.pdf' })).toBeInTheDocument();
    unmount();
    expect(stop).toHaveBeenCalledOnce();
  });
  it('filters every category across statuses and updates sidebar counts after a same-status correction', async () => {
    const user = userEvent.setup();
    const playing = makeTask({ fileName: 'đang-tải.mkv', category: 'video', createdAt: 200 });
    await renderReady({ tasks: [
      playing,
      makeTask({ id: 'complete', fileName: 'xong.mp4', category: 'video', status: 'completed', done: 100 }),
      makeTask({ id: 'failed', fileName: 'lỗi.webm', category: 'video', status: 'failed' }),
      makeTask({ id: 'canceled', fileName: 'đã-hủy.mov', category: 'video', status: 'canceled' }),
      makeTask({ id: 'song', fileName: 'bài-hát.flac', category: 'music', status: 'queued' }),
      makeTask({ id: 'document', fileName: 'báo-cáo.pdf', category: 'doc', status: 'probing' }),
      makeTask({ id: 'archive', fileName: 'tệp-nén.7z', category: 'archive', status: 'completed', done: 100 }),
      makeTask({ id: 'other', fileName: 'dữ-liệu.bin', category: 'other', status: 'canceled' }),
    ], stats: emptyStats });
    const statusNav = screen.getByRole('navigation', { name: 'Lọc tác vụ' });
    const categoryNav = screen.getByRole('navigation', { name: 'Lọc theo loại tệp' });
    const groups = [
      ['Video', ['đang-tải.mkv', 'xong.mp4', 'lỗi.webm', 'đã-hủy.mov']],
      ['Nhạc', ['bài-hát.flac']], ['Tài liệu', ['báo-cáo.pdf']],
      ['File nén', ['tệp-nén.7z']], ['Khác', ['dữ-liệu.bin']],
    ] as const;
    for (const [label, files] of groups) {
      const button = within(categoryNav).getByRole('button', { name: new RegExp(`^${label}`) });
      expect(within(button).getByText(String(files.length))).toBeInTheDocument();
      await user.click(button);
      expect(button).toHaveAttribute('aria-current', 'page');
      expect(within(statusNav).queryByRole('button', { current: 'page' })).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: label, level: 2 })).toBeInTheDocument();
      expect(screen.getAllByRole('article').map((row) => within(row).getByRole('heading').textContent)).toEqual(files);
    }
    const video = within(categoryNav).getByRole('button', { name: /^Video/ });
    await user.click(video);
    const onEvent = vi.mocked(api.subscribe).mock.calls[0][0];
    act(() => onEvent({ type: 'task:status', task: { ...playing, fileName: 'tên-được-chọn.mp3', category: 'music' } }));
    expect(screen.queryByRole('article', { name: 'đang-tải.mkv' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(within(video).getByText('3')).toBeInTheDocument();
    const music = within(categoryNav).getByRole('button', { name: /^Nhạc/ });
    expect(within(music).getByText('2')).toBeInTheDocument();
    expect(within(within(statusNav).getByRole('button', { name: /^Tất cả/ })).getByText('8')).toBeInTheDocument();
    expect(within(within(statusNav).getByRole('button', { name: /^Đang tải/ })).getByText('3')).toBeInTheDocument();
    expect(within(within(statusNav).getByRole('button', { name: /^Hoàn tất/ })).getByText('2')).toBeInTheDocument();
    expect(within(within(statusNav).getByRole('button', { name: /^Thất bại/ })).getByText('1')).toBeInTheDocument();
    await user.click(music);
    expect(screen.getByRole('article', { name: 'tên-được-chọn.mp3' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'bài-hát.flac' })).toBeInTheDocument();
    await user.click(within(statusNav).getByRole('button', { name: /^Đang tải/ }));
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(within(categoryNav).queryByRole('button', { current: 'page' })).not.toBeInTheDocument();
  });
  it.each([
    ['Video', 'Chưa có video.'], ['Nhạc', 'Chưa có tệp nhạc.'], ['Tài liệu', 'Chưa có tài liệu.'],
    ['File nén', 'Chưa có file nén.'], ['Khác', 'Chưa có tệp khác.'],
  ])('shows the %s empty state and keeps adding available', async (label, title) => {
    const user = userEvent.setup();
    await renderReady();
    const nav = screen.getByRole('navigation', { name: 'Lọc theo loại tệp' });
    const button = within(nav).getByRole('button', { name: new RegExp(`^${label}`) });
    await user.click(button);
    expect(within(button).getByText('0')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByText(/ở mọi trạng thái tải/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Thêm URL mới' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
