import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskDetailDialog } from './TaskDetailDialog';
import { api } from '../lib/api';
import type { TaskDetail } from '../lib/types';
import { useTaskStore } from '../store/tasks';
import { emptyStats, makeTask, settings } from '../test/fixtures';

vi.mock('../lib/api', () => ({ api: { getTaskDetail: vi.fn() } }));

const detail = (id = 'task-1'): TaskDetail => ({
  task: makeTask({ id, segCount: 2, segs: [100, 50], done: 75, speed: 1024, etaSec: 2 }),
  segments: [{ index: 0, start: 0, end: 49, done: 50, status: 'completed' }, { index: 1, start: 50, end: 99, done: 25, status: 'downloading' }],
});
function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  useTaskStore.getState().loadSnapshot({ tasks: [makeTask(), makeTask({ id: 'second', fileName: 'thứ-hai.zip', category: 'archive' })], stats: emptyStats }, settings, []);
  vi.mocked(api.getTaskDetail).mockResolvedValue(detail());
});

describe('task detail dialog', () => {
  it('fetches only when opened and displays inclusive byte ranges and actual segment status', async () => {
    const onClose = vi.fn();
    const pending = deferred<TaskDetail>();
    vi.mocked(api.getTaskDetail).mockReturnValue(pending.promise);
    const { rerender } = render(<TaskDetailDialog id={null} onClose={onClose} />);
    expect(api.getTaskDetail).not.toHaveBeenCalled();
    rerender(<TaskDetailDialog id="task-1" onClose={onClose} />);
    expect(screen.getByRole('status')).toHaveTextContent('Đang tải chi tiết');
    expect(screen.getByRole('button', { name: 'Làm mới' })).toBeDisabled();
    await act(async () => pending.resolve(detail()));
    expect(screen.getByText('1 KB/s')).toBeInTheDocument();
    expect(screen.getByText('2 giây')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Chi tiết đoạn 1' })).toHaveTextContent('Byte 0 – 49');
    expect(screen.getByRole('group', { name: 'Chi tiết đoạn 1' })).toHaveTextContent('50 B / 50 B · 100%');
    expect(screen.getByRole('group', { name: 'Chi tiết đoạn 2' })).toHaveTextContent('25 B / 50 B · 50%');
    expect(screen.getByRole('button', { name: 'Đóng chi tiết' })).toHaveFocus();
  });
  it('shows failed and empty responses and allows explicit refresh', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getTaskDetail).mockRejectedValueOnce(new Error('Không tìm thấy tác vụ')).mockResolvedValueOnce({ task: makeTask({ segs: [] }), segments: [] });
    render(<TaskDetailDialog id="task-1" onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Không tìm thấy tác vụ');
    await user.click(screen.getByRole('button', { name: 'Làm mới' }));
    expect(await screen.findByText(/Chưa có dữ liệu đoạn tải/)).toBeInTheDocument();
    expect(api.getTaskDetail).toHaveBeenCalledTimes(2);
  });
  it('handles a single stream of unknown length without displaying an invented percentage', async () => {
    vi.mocked(api.getTaskDetail).mockResolvedValue({ task: makeTask({ total: -1, segs: [0] }), segments: [{ index: 0, start: 0, end: -1, done: 25, status: 'downloading' }] });
    render(<TaskDetailDialog id="task-1" onClose={vi.fn()} />);
    expect(await screen.findByRole('group', { name: 'Chi tiết đoạn 1' })).toHaveTextContent('Byte 0 – chưa rõ25 B / Chưa rõĐang tải');
    expect(screen.getByRole('group', { name: 'Chi tiết đoạn 1' })).not.toHaveTextContent('%');
  });
  it('ignores a stale request after selecting another task, and late errors after closing', async () => {
    const first = deferred<TaskDetail>(), second = deferred<TaskDetail>();
    vi.mocked(api.getTaskDetail).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onClose = vi.fn();
    const { rerender } = render(<TaskDetailDialog id="task-1" onClose={onClose} />);
    rerender(<TaskDetailDialog id="second" onClose={onClose} />);
    await act(async () => second.resolve(detail('second')));
    expect(screen.getByText('thứ-hai.zip')).toBeInTheDocument();
    await act(async () => first.resolve({ task: makeTask(), segments: [] }));
    expect(screen.getByRole('group', { name: 'Chi tiết đoạn 2' })).toBeInTheDocument();
    expect(screen.queryByText(/Chưa có dữ liệu đoạn tải/)).not.toBeInTheDocument();
    const late = deferred<TaskDetail>();
    vi.mocked(api.getTaskDetail).mockReturnValueOnce(late.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Làm mới' }));
    rerender(<TaskDetailDialog id={null} onClose={onClose} />);
    await act(async () => late.reject(new Error('late error')));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('late error')).not.toBeInTheDocument();
  });
  it('fetches for status changes but not for high frequency progress or closed tasks', async () => {
    const { rerender } = render(<TaskDetailDialog id="task-1" onClose={vi.fn()} />);
    await screen.findByRole('group', { name: 'Chi tiết đoạn 1' });
    act(() => useTaskStore.getState().applyEvent({ type: 'tasks:progress', items: [{ id: 'task-1', done: 30, total: 100, speed: 12, etaSec: 5, segs: [30] }] }));
    expect(api.getTaskDetail).toHaveBeenCalledTimes(1);
    act(() => useTaskStore.getState().applyEvent({ type: 'task:status', task: makeTask({ status: 'completed', done: 100, segs: [100] }) }));
    await waitFor(() => expect(api.getTaskDetail).toHaveBeenCalledTimes(2));
    rerender(<TaskDetailDialog id={null} onClose={vi.fn()} />);
    act(() => useTaskStore.getState().applyEvent({ type: 'task:added', task: makeTask({ id: 'third' }) }));
    expect(api.getTaskDetail).toHaveBeenCalledTimes(2);
  });
  it('rejects a mismatched detail and stops fetching while disconnected', async () => {
    vi.mocked(api.getTaskDetail).mockResolvedValue(detail('wrong'));
    render(<TaskDetailDialog id="task-1" onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('không khớp');
    act(() => useTaskStore.getState().failConnection('offline'));
    expect(screen.getByRole('alert')).toHaveTextContent('Mất kết nối');
    expect(screen.getByRole('button', { name: 'Làm mới' })).toBeDisabled();
    expect(api.getTaskDetail).toHaveBeenCalledOnce();
  });
  it('traps keyboard focus, supports Escape and restores the trigger', async () => {
    const user = userEvent.setup();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const { rerender, unmount } = render(<TaskDetailDialog id="task-1" onClose={onClose} />);
    await screen.findByRole('group', { name: 'Chi tiết đoạn 1' });
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Đóng' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Đóng chi tiết' })).toHaveFocus();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
    rerender(<TaskDetailDialog id={null} onClose={onClose} />);
    expect(trigger).toHaveFocus();
    unmount();
    trigger.remove();
  });
});
