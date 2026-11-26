import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { TaskList } from './TaskList';
import { useTaskStore } from '../store/tasks';
import { emptyStats, makeTask, settings } from '../test/fixtures';

vi.mock('../lib/api', () => ({ api: { cancel: vi.fn() } }));

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width: 900, height: 154, top: 0, left: 0, right: 900, bottom: 154, x: 0, y: 0, toJSON() {},
  }));
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(154);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(460);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(77000);
  HTMLElement.prototype.scrollTo = vi.fn();
  const tasks = Array.from({ length: 500 }, (_, index) => makeTask({
    id: `task-${index}`, fileName: `tệp-${index}.pdf`, createdAt: 500 - index,
  }));
  useTaskStore.getState().loadSnapshot({ tasks, stats: emptyStats }, settings, []);
});

describe('virtual task list', () => {
  it.each(['all', 'doc'] as const)('mounts a bounded window from 500 tasks in %s with complete list position metadata', (filter) => {
    render(<TaskList filter={filter} onAdd={vi.fn()} onDetail={vi.fn()} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(25);
    expect(rows[0]).toHaveAttribute('aria-posinset', '1');
    expect(rows[0]).toHaveAttribute('aria-setsize', '500');
    expect(screen.queryByRole('heading', { name: 'tệp-499.pdf' })).not.toBeInTheDocument();
  });

  it('reaches unmounted tasks using End, arrows and Home without losing task identity', () => {
    render(<TaskList filter="all" onAdd={vi.fn()} onDetail={vi.fn()} />);
    const region = screen.getByRole('region', { name: 'Danh sách tải xuống' });
    region.focus();
    fireEvent.keyDown(region, { key: 'End' });
    const last = screen.getByRole('heading', { name: 'tệp-499.pdf' }).closest<HTMLElement>('[role="listitem"]')!;
    expect(last).toHaveFocus();
    expect(within(last).getByRole('button', { name: 'Hủy tải tệp-499.pdf' })).toBeEnabled();
    fireEvent.keyDown(last, { key: 'ArrowUp' });
    expect(screen.getByRole('heading', { name: 'tệp-498.pdf' }).closest('[role="listitem"]')).toHaveFocus();
    act(() => useTaskStore.getState().applyEvent({ type: 'task:added', task: makeTask({ id: 'new', createdAt: 1000 }) }));
    expect(screen.getByRole('heading', { name: 'tệp-498.pdf' }).closest('[role="listitem"]')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(screen.getByRole('heading', { name: 'tài-liệu.pdf' }).closest('[role="listitem"]')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(screen.getByRole('heading', { name: 'tệp-0.pdf' }).closest('[role="listitem"]')).toHaveFocus();
  });
});
