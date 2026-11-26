import { api } from './api';
import type { BackendEvent } from './types';
import { emptyStats, makeTask } from '../test/fixtures';

afterEach(() => vi.unstubAllGlobals());

function bridge() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const stop = vi.fn();
  const register = vi.fn((name: string, callback: (payload: unknown) => void) => { listeners.set(name, callback); return stop; });
  const native = {
    ListTasks: vi.fn().mockResolvedValue({ tasks: [makeTask({ segs: [100, 20], segCount: 2 })], stats: { ...emptyStats, globalSpeed: 1024 } }),
    AddURLs: vi.fn().mockResolvedValue({ ids: ['task-1'], errors: [] }),
    GetTaskDetail: vi.fn().mockResolvedValue({ task: makeTask({ segs: [50] }), segments: [{ index: 0, start: 0, end: 99, done: 50, status: 'downloading' }] }),
  };
  vi.stubGlobal('go', { main: { App: native } });
  vi.stubGlobal('runtime', { EventsOn: register, EventsOnMultiple: register });
  return { native, listeners, stop };
}

describe('generated bridge adapter', () => {
  it('decodes actual v0.2 snapshot and detail shapes through generated functions', async () => {
    const { native } = bridge();
    const snapshot = await api.listTasks();
    expect(snapshot.tasks[0].segs).toEqual([100, 20]);
    expect(snapshot.stats.globalSpeed).toBe(1024);
    const detail = await api.getTaskDetail('task-1');
    expect(native.GetTaskDetail).toHaveBeenCalledWith('task-1');
    expect(detail.segments).toEqual([{ index: 0, start: 0, end: 99, done: 50, status: 'downloading' }]);
    expect(detail.task.segs).toEqual([50]);
    await api.addURLs({ urls: ['https://example.com/file'], saveDir: '', segments: 32 });
    expect(native.AddURLs).toHaveBeenCalledWith({ urls: ['https://example.com/file'], saveDir: '', segments: 32 });
  });
  it('handles null Go slices without inventing progress and rejects a wrong detail task', async () => {
    const { native } = bridge();
    native.GetTaskDetail.mockResolvedValueOnce({ task: makeTask({ segs: [] }), segments: null });
    expect((await api.getTaskDetail('task-1')).segments).toEqual([]);
    native.GetTaskDetail.mockResolvedValueOnce({ task: makeTask({ id: 'wrong' }), segments: [] });
    await expect(api.getTaskDetail('task-1')).rejects.toThrow('không khớp');
  });
  it('decodes segment progress and status events and reports malformed numeric data', () => {
    const { listeners, stop } = bridge();
    const events: BackendEvent[] = [];
    const error = vi.fn();
    const unsubscribe = api.subscribe((event) => events.push(event), error);
    listeners.get('tasks:progress')!({ items: [{ id: 'task-1', total: 100, done: 60, speed: 12, etaSec: 4, segs: [100, 20] }] });
    listeners.get('task:status')!(makeTask({ segs: [100, 100], status: 'completed', done: 100 }));
    expect(events).toMatchObject([
      { type: 'tasks:progress', items: [{ segs: [100, 20], speed: 12, etaSec: 4 }] },
      { type: 'task:status', task: { segs: [100, 100], status: 'completed' } },
    ]);
    listeners.get('tasks:progress')!({ items: [{ id: 'task-1', total: 100, done: 60, speed: Number.NaN, etaSec: 4, segs: [100] }] });
    expect(error).toHaveBeenCalledOnce();
    expect(events).toHaveLength(2);
    unsubscribe();
    expect(stop).toHaveBeenCalledTimes(4);
  });
  it('reports missing bridge instead of exposing a native TypeError', async () => {
    vi.stubGlobal('go', undefined);
    await expect(api.getTaskDetail('task-1')).rejects.toThrow('Chưa kết nối với GoGet');
  });
});
