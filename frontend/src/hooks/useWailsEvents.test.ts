import { connectBackend } from './useWailsEvents';
import { createTaskStore } from '../store/tasks';
import { emptyStats, makeTask, settings } from '../test/fixtures';
import type { BackendAPI, BackendEvent, Settings, Snapshot } from '../lib/types';

vi.mock('../lib/api', () => ({ api: {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function backend() {
  const snapshot = deferred<Snapshot>();
  const config = deferred<Settings>();
  let emit!: (event: BackendEvent) => void;
  let fail!: (error: unknown) => void;
  const stop = vi.fn();
  const api: BackendAPI = {
    listTasks: vi.fn(() => snapshot.promise), getSettings: vi.fn(() => config.promise),
    subscribe: vi.fn((handler, onError) => { emit = handler; fail = onError; return stop; }),
    addURLs: vi.fn(), cancel: vi.fn(), cancelAll: vi.fn(), pickDirectory: vi.fn(),
  };
  return { api, snapshot, config, emit: (event: BackendEvent) => emit(event), fail: (error: unknown) => fail(error), stop };
}

describe('Wails subscription lifecycle', () => {
  it('subscribes first and buffers until both the snapshot and settings finish', async () => {
    const service = backend();
    const store = createTaskStore();
    const disconnect = connectBackend(service.api, store);
    expect(vi.mocked(service.api.subscribe).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(service.api.listTasks).mock.invocationCallOrder[0]);
    service.emit({ type: 'task:status', task: makeTask({ status: 'completed', done: 100 }) });
    service.snapshot.resolve({ tasks: [makeTask({ done: 10 })], stats: emptyStats });
    await Promise.resolve();
    expect(store.getState().connection).toBe('connecting');
    service.config.resolve(settings);
    await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
    expect(store.getState().tasks['task-1'].status).toBe('completed');
    service.emit({ type: 'task:added', task: makeTask({ id: 'new-task' }) });
    expect(store.getState().order).toContain('new-task');
    disconnect();
    expect(service.stop).toHaveBeenCalledOnce();
  });

  it('disposes subscriptions and ignores late events and fetches after unmount', async () => {
    const service = backend();
    const store = createTaskStore();
    const disconnect = connectBackend(service.api, store);
    service.emit({ type: 'task:added', task: makeTask() });
    disconnect();
    service.snapshot.resolve({ tasks: [makeTask()], stats: emptyStats });
    service.config.resolve(settings);
    service.emit({ type: 'task:added', task: makeTask({ id: 'late' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().order).toEqual([]);
    expect(service.stop).toHaveBeenCalledOnce();
  });

  it('keeps events emitted synchronously while installing the initial snapshot', async () => {
    const service = backend();
    const store = createTaskStore();
    const stopWatching = store.subscribe((state, previous) => {
      if (state.connection === 'connected' && previous.connection !== 'connected') {
        service.emit({ type: 'task:added', task: makeTask({ id: 'during-install' }) });
      }
    });
    const disconnect = connectBackend(service.api, store);
    service.snapshot.resolve({ tasks: [], stats: emptyStats });
    service.config.resolve(settings);
    await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
    expect(store.getState().order).toEqual(['during-install']);
    stopWatching();
    disconnect();
  });

  it('never lets an old request overwrite a newer reconnect snapshot', async () => {
    const old = backend();
    const fresh = backend();
    const store = createTaskStore();
    const disconnectOld = connectBackend(old.api, store);
    disconnectOld();
    const disconnectFresh = connectBackend(fresh.api, store);
    fresh.snapshot.resolve({ tasks: [makeTask({ id: 'fresh', status: 'completed' })], stats: emptyStats });
    fresh.config.resolve(settings);
    await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
    old.snapshot.resolve({ tasks: [makeTask({ id: 'stale' })], stats: emptyStats });
    old.config.resolve(settings);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().order).toEqual(['fresh']);
    disconnectFresh();
  });

  it('shows an initial fetch failure and stops listening', async () => {
    const service = backend();
    const store = createTaskStore();
    const disconnect = connectBackend(service.api, store);
    service.snapshot.reject(new Error('Mất kết nối'));
    await vi.waitFor(() => expect(store.getState().connection).toBe('error'));
    expect(store.getState().connectionError).toBe('Mất kết nối');
    expect(service.stop).toHaveBeenCalled();
    disconnect();
  });

  it('stops after an event decoder failure and ignores an outstanding snapshot', async () => {
    const service = backend();
    const store = createTaskStore();
    connectBackend(service.api, store);
    service.fail(new Error('Dữ liệu không hợp lệ'));
    service.snapshot.resolve({ tasks: [makeTask()], stats: emptyStats });
    service.config.resolve(settings);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().connection).toBe('error');
    expect(store.getState().order).toEqual([]);
    expect(service.stop).toHaveBeenCalledOnce();
  });
});
