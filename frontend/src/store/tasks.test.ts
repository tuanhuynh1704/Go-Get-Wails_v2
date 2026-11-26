import { createTaskStore } from './tasks';
import { emptyStats, makeTask, settings } from '../test/fixtures';
import type { BackendEvent } from '../lib/types';

describe('task snapshots and events', () => {
  it('replays bootstrap events after a stale snapshot in received order', () => {
    const store = createTaskStore();
    const queued = makeTask({ status: 'queued', done: 0 });
    const buffered: BackendEvent[] = [
      { type: 'task:status', task: makeTask({ done: 35 }) },
      { type: 'tasks:progress', items: [{ id: queued.id, done: 60, total: 100, speed: 12, etaSec: 4, segs: [] }] },
      { type: 'task:added', task: makeTask({ id: 'second', status: 'queued', createdAt: 200, done: 0 }) },
      { type: 'stats:update', stats: { active: 1, queued: 1, globalSpeed: 12 } },
    ];
    store.getState().loadSnapshot({ tasks: [queued], stats: emptyStats }, settings, buffered);
    expect(store.getState().tasks[queued.id]).toMatchObject({ done: 60, status: 'downloading' });
    expect(store.getState().order).toEqual(['second', queued.id]);
    expect(store.getState().filterIDs.downloading).toHaveLength(2);
    expect(store.getState().stats).toEqual({ active: 1, queued: 1, globalSpeed: 12 });
  });

  it.each(['completed', 'failed', 'canceled'] as const)('does not regress %s through late progress or duplicate active task events', (status) => {
    const store = createTaskStore();
    store.getState().loadSnapshot({ tasks: [makeTask()], stats: emptyStats }, settings, []);
    store.getState().applyEvent({ type: 'task:status', task: makeTask({ status, done: 70, speed: 100 }) });
    store.getState().applyEvent({ type: 'tasks:progress', items: [{ id: 'task-1', done: 40, total: -1, speed: 200, etaSec: 2, segs: [] }] });
    store.getState().applyEvent({ type: 'task:added', task: makeTask({ done: 30 }) });
    expect(store.getState().tasks['task-1']).toMatchObject({ status, done: 70, speed: 0, total: 100 });
    expect(store.getState().filterIDs.downloading).toEqual([]);
  });

  it('keeps a terminal snapshot authoritative over older buffered active events', () => {
    const store = createTaskStore();
    store.getState().loadSnapshot({ tasks: [makeTask({ status: 'completed', done: 100 })], stats: emptyStats }, settings, [
      { type: 'task:status', task: makeTask({ done: 50 }) },
      { type: 'tasks:progress', items: [{ id: 'task-1', done: 60, total: 100, speed: 100, etaSec: 1, segs: [] }] },
    ]);
    expect(store.getState().tasks['task-1']).toMatchObject({ status: 'completed', done: 100, speed: 0 });
    expect(store.getState().filterIDs.completed).toEqual(['task-1']);
  });

  it('ignores out-of-order progress and preserves known totals', () => {
    const store = createTaskStore();
    store.getState().loadSnapshot({ tasks: [makeTask({ done: 50 })], stats: emptyStats }, settings, []);
    const idsBefore = store.getState().filterIDs;
    store.getState().applyEvent({ type: 'tasks:progress', items: [{ id: 'task-1', done: 20, total: 100, speed: 8, etaSec: 10, segs: [] }] });
    store.getState().applyEvent({ type: 'tasks:progress', items: [{ id: 'task-1', done: 60, total: -1, speed: 9, etaSec: 8, segs: [] }] });
    store.getState().applyEvent({ type: 'task:status', task: makeTask({ status: 'probing', done: 0 }) });
    expect(store.getState().tasks['task-1']).toMatchObject({ done: 60, total: 100, status: 'downloading' });
    expect(store.getState().filterIDs).toBe(idsBefore);
  });

  it('keeps canceled tasks visible in All without labeling them failures', () => {
    const store = createTaskStore();
    store.getState().loadSnapshot({ tasks: [makeTask({ status: 'canceled' })], stats: emptyStats }, settings, []);
    expect(store.getState().filterIDs).toEqual({ all: ['task-1'], downloading: [], completed: [], failed: [] });
  });
});
