import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddDialog } from './AddDialog';
import { api } from '../lib/api';
import { useTaskStore } from '../store/tasks';
import { emptyStats, settings } from '../test/fixtures';

vi.mock('../lib/api', () => ({ api: { addURLs: vi.fn(), pickDirectory: vi.fn() } }));

beforeEach(() => {
  vi.resetAllMocks();
  useTaskStore.getState().loadSnapshot({ tasks: [], stats: emptyStats }, settings, []);
});

function mount() {
  const onClose = vi.fn();
  const onAdded = vi.fn();
  render(<AddDialog open onClose={onClose} onAdded={onAdded} />);
  return { onClose, onAdded, input: screen.getByRole('textbox', { name: 'URL tải xuống' }), submit: screen.getByRole('button', { name: 'Bắt đầu tải' }) };
}

describe('Add URLs dialog', () => {
  it.each(['', '0', '33', '1.5', '-1'])('rejects invalid segment count %j before calling the backend', async (value) => {
    const { input, submit } = mount();
    fireEvent.change(input, { target: { value: 'https://example.com/a' } });
    const segments = screen.getByRole('spinbutton', { name: 'Số đoạn' });
    expect(segments).toHaveValue(8);
    fireEvent.change(segments, { target: { value } });
    fireEvent.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent('Số đoạn phải là số nguyên từ 1 đến 32');
    expect(segments).toHaveFocus();
    expect(segments).toHaveAttribute('aria-invalid', 'true');
    expect(api.addURLs).not.toHaveBeenCalled();
  });
  it.each([1, 32])('sends supported segment boundary %s', async (segments) => {
    vi.mocked(api.addURLs).mockResolvedValue({ ids: ['first'], errors: [] });
    const { input, submit } = mount();
    fireEvent.change(input, { target: { value: 'https://example.com/a' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Số đoạn' }), { target: { value: String(segments) } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.addURLs).toHaveBeenCalledWith({ urls: ['https://example.com/a'], saveDir: '', segments }));
  });
  it('uses the configured default and falls back to eight for invalid settings', () => {
    useTaskStore.setState({ settings: { ...settings, segmentsPerFile: 12 } });
    mount();
    expect(screen.getByRole('spinbutton', { name: 'Số đoạn' })).toHaveValue(12);
    act(() => useTaskStore.setState({ settings: { ...settings, segmentsPerFile: 0 } }));
    expect(screen.getByRole('spinbutton', { name: 'Số đoạn' })).toHaveValue(8);
  });
  it('focuses the URL field and validates required input, protocols and 100 URL limit', async () => {
    const user = userEvent.setup();
    const { input, submit } = mount();
    expect(input).toHaveFocus();
    await user.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent('Nhập ít nhất một URL');
    fireEvent.change(input, { target: { value: 'ftp://example.com/file\nnot-a-url' } });
    await user.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent('Dòng 1');
    expect(screen.getByRole('alert')).toHaveTextContent('Dòng 2');
    fireEvent.change(input, { target: { value: Array.from({ length: 101 }, (_, index) => `https://example.com/${index}`).join('\n') } });
    await user.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent('tối đa 100 URL');
    expect(api.addURLs).not.toHaveBeenCalled();
  });

  it('uses the backend default without allowing a freely typed directory', async () => {
    const user = userEvent.setup();
    vi.mocked(api.addURLs).mockResolvedValue({ ids: ['first', 'second'], errors: [] });
    const { input, submit, onClose, onAdded } = mount();
    expect(screen.getByLabelText('Thư mục lưu')).toHaveTextContent(settings.downloadDir);
    expect(screen.queryByRole('textbox', { name: 'Thư mục lưu' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '  https://example.com/a  \r\n\nhttp://example.com/b ' } });
    await user.click(submit);
    expect(api.addURLs).toHaveBeenCalledWith({ urls: ['https://example.com/a', 'http://example.com/b'], saveDir: '', segments: 8 });
    expect(onAdded).toHaveBeenCalledWith(2);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('only sends a directory returned by the native picker and preserves it if picking is canceled', async () => {
    const user = userEvent.setup();
    vi.mocked(api.pickDirectory).mockResolvedValueOnce('D:\\Approved').mockResolvedValueOnce('');
    vi.mocked(api.addURLs).mockResolvedValue({ ids: ['first'], errors: [] });
    const { input, submit } = mount();
    await user.click(screen.getByRole('button', { name: 'Chọn thư mục' }));
    expect(screen.getByLabelText('Thư mục lưu')).toHaveTextContent('D:\\Approved');
    await user.click(screen.getByRole('button', { name: 'Chọn thư mục' }));
    fireEvent.change(input, { target: { value: 'https://example.com/a' } });
    await user.click(submit);
    expect(api.addURLs).toHaveBeenCalledWith({ urls: ['https://example.com/a'], saveDir: 'D:\\Approved', segments: 8 });
  });

  it('shows picker and AddURLs failures in the dialog', async () => {
    const user = userEvent.setup();
    vi.mocked(api.pickDirectory).mockRejectedValue(new Error('Không mở được hộp thoại'));
    vi.mocked(api.addURLs).mockRejectedValue('Không có quyền ghi');
    const { input, submit, onClose } = mount();
    await user.click(screen.getByRole('button', { name: 'Chọn thư mục' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Không mở được hộp thoại');
    fireEvent.change(input, { target: { value: 'https://example.com/a' } });
    await user.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent('Không có quyền ghi');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports partial rejection and retries only URLs that were rejected', async () => {
    const user = userEvent.setup();
    vi.mocked(api.addURLs).mockResolvedValueOnce({ ids: ['first'], errors: [{ url: 'https://example.com/b', error: '<script>not executable</script>' }] }).mockResolvedValueOnce({ ids: ['second'], errors: [] });
    const { input, submit, onClose, onAdded } = mount();
    fireEvent.change(input, { target: { value: 'https://example.com/a\nhttps://example.com/b' } });
    await user.click(submit);
    expect(onClose).not.toHaveBeenCalled();
    expect(onAdded).toHaveBeenCalledWith(1);
    expect(input).toHaveValue('https://example.com/b');
    expect(screen.getByRole('alert')).toHaveTextContent('<script>not executable</script>');
    expect(document.querySelector('script')).toBeNull();
    await user.click(submit);
    expect(api.addURLs).toHaveBeenLastCalledWith({ urls: ['https://example.com/b'], saveDir: '', segments: 8 });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('disables duplicate submissions until the request settles', async () => {
    const user = userEvent.setup();
    let resolve!: (result: { ids: string[]; errors: [] }) => void;
    vi.mocked(api.addURLs).mockReturnValue(new Promise((yes) => { resolve = yes; }));
    const { input, submit } = mount();
    fireEvent.change(input, { target: { value: 'https://example.com/a' } });
    await user.dblClick(submit);
    expect(api.addURLs).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Đang thêm…' })).toBeDisabled();
    resolve({ ids: ['first'], errors: [] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu tải' })).toBeEnabled());
  });

  it('handles native Escape cancellation and restores focus when closed', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const { rerender, unmount } = render(<AddDialog open onClose={onClose} onAdded={vi.fn()} />);
    const modal = screen.getByRole('dialog');
    fireEvent(modal, new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
    rerender(<AddDialog open={false} onClose={onClose} onAdded={vi.fn()} />);
    expect(trigger).toHaveFocus();
    expect(modal).not.toHaveAttribute('open');
    unmount();
    trigger.remove();
  });

  it('wraps Tab and Shift+Tab inside the modal', async () => {
    const user = userEvent.setup();
    const { input, submit } = mount();
    await user.tab({ shift: true });
    const first = screen.getByRole('button', { name: 'Đóng hộp thoại' });
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(submit).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
  });

  it('does not close a newly reopened dialog when an earlier submission settles', async () => {
    const user = userEvent.setup();
    let resolve!: (result: { ids: string[]; errors: [] }) => void;
    vi.mocked(api.addURLs).mockReturnValue(new Promise((yes) => { resolve = yes; }));
    const onClose = vi.fn();
    const onAdded = vi.fn();
    const { rerender } = render(<AddDialog open onClose={onClose} onAdded={onAdded} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://example.com/a' } });
    await user.click(screen.getByRole('button', { name: 'Bắt đầu tải' }));
    rerender(<AddDialog open={false} onClose={onClose} onAdded={onAdded} />);
    rerender(<AddDialog open onClose={onClose} onAdded={onAdded} />);
    resolve({ ids: ['first'], errors: [] });
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});
