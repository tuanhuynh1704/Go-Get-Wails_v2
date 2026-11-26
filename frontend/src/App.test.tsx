import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { api } from './lib/api';
import { useTaskStore } from './store/tasks';
import { emptyStats, makeTask, settings } from './test/fixtures';
import type { Snapshot } from './lib/types';

vi.mock('./lib/api', () => ({ api: {
  addURLs: vi.fn(), listTasks: vi.fn(), getSettings: vi.fn(), subscribe: vi.fn(),
  cancel: vi.fn(), cancelAll: vi.fn(), pickDirectory: vi.fn(),
} }));

beforeEach(() => {
  vi.resetAllMocks();
  useTaskStore.setState({ tasks: {}, order: [], filterIDs: { all: [], downloading: [], completed: [], failed: [] }, stats: emptyStats, settings: null, connection: 'connecting', connectionError: null });
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
    await renderReady({ tasks: [makeTask({ fileName, total: -1 }), makeTask({ id: 'failed', status: 'failed', error: 'Máy chủ trả về 404', createdAt: 101 })], stats: { active: 1, queued: 0, globalSpeed: 0 } });
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
    const { unmount } = await renderReady({ tasks: [makeTask(), makeTask({ id: 'complete', fileName: 'xong.zip', status: 'completed', done: 100 }), makeTask({ id: 'failed', fileName: 'loi.zip', status: 'failed' })], stats: emptyStats });
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
});
