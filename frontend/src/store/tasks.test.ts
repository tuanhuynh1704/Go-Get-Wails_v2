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
  it('retains snapshot segments then replays newer segment events without rebuilding filter membership', () => {
    const store = createTaskStore();
    store.getState().loadSnapshot({ tasks: [makeTask({ segs: [40, 60], segCount: 2, done: 50 })], stats: emptyStats }, settings, [
      { type: 'tasks:progress', items: [{ id: 'task-1', done: 60, total: 100, speed: 10, etaSec: 4, segs: [50, 70] }] },
    ]);
    expect(store.getState().tasks['task-1']).toMatchObject({ segs: [50, 70], speed: 10, etaSec: 4 });
    const filters = store.getState().filterIDs;
    store.getState().applyEvent({ type: 'task:status', task: makeTask({ done: 60, segs: [40, 60], segCount: 2 }) });
    expect(store.getState().tasks['task-1'].segs).toEqual([50, 70]);
    expect(store.getState().filterIDs).toBe(filters);
    store.getState().applyEvent({ type: 'task:status', task: makeTask({ done: 60, segs: [], segCount: 2 }) });
    expect(store.getState().tasks['task-1'].segs).toEqual([50, 70]);
  });
  it('accepts actual single-stream topology and ignores late progress after completion', () => {
    const store = createTaskStore();
    store.getState().loadSnapshot({ tasks: [makeTask({ segs: [0, 0, 0, 0], segCount: 4, done: 0 })], stats: emptyStats }, settings, []);
    store.getState().applyEvent({ type: 'tasks:progress', items: [{ id: 'task-1', done: 50, total: 100, speed: 25, etaSec: 2, segs: [50] }] });
    expect(store.getState().tasks['task-1']).toMatchObject({ segs: [50], segCount: 1 });
    store.getState().applyEvent({ type: 'task:status', task: makeTask({ status: 'completed', done: 100, segs: [100], speed: 30 }) });
    store.getState().applyEvent({ type: 'tasks:progress', items: [{ id: 'task-1', done: 100, total: 100, speed: 25, etaSec: 1, segs: [90] }] });
    expect(store.getState().tasks['task-1']).toMatchObject({ segs: [100], speed: 0, done: 100 });
  });
  it('honors a clean fallback reset and rejects delayed progress from the abandoned split', () => {
    const store = createTaskStore();
    store.getState().loadSnapshot({ tasks: [makeTask({ segs: [100, 50], segCount: 2, done: 75 })], stats: emptyStats }, settings, []);
    store.getState().applyEvent({ type: 'task:status', task: makeTask({ segCount: 1, segs: [0], done: 0, total: -1, speed: 0, resumable: false }) });
    expect(store.getState().tasks['task-1']).toMatchObject({ done: 0, total: -1, segs: [0], segCount: 1 });
    store.getState().applyEvent({ type: 'tasks:progress', items: [{ id: 'task-1', done: 80, total: 100, speed: 40, etaSec: 1, segs: [100, 60] }] });
    store.getState().applyEvent({ type: 'task:status', task: makeTask({ done: 80, segCount: 2, segs: [100, 60] }) });
    expect(store.getState().tasks['task-1']).toMatchObject({ done: 0, total: -1, segs: [0], segCount: 1 });
    store.getState().applyEvent({ type: 'tasks:progress', items: [{ id: 'task-1', done: 20, total: 100, speed: 10, etaSec: 8, segs: [20] }] });
    expect(store.getState().tasks['task-1']).toMatchObject({ done: 20, segs: [20], speed: 10 });
  });
  it.each(['failed', 'canceled'] as const)('retains final partial segment progress for %s', (status) => {
    const store = createTaskStore();
    store.getState().loadSnapshot({ tasks: [makeTask({ segs: [100, 50], segCount: 2, done: 75 })], stats: emptyStats }, settings, []);
    store.getState().applyEvent({ type: 'task:status', task: makeTask({ status, segs: [100, 50], segCount: 2, done: 75 }) });
    store.getState().applyEvent({ type: 'tasks:progress', items: [{ id: 'task-1', done: 100, total: 100, speed: 40, etaSec: 0, segs: [100, 100] }] });
    expect(store.getState().tasks['task-1']).toMatchObject({ status, segs: [100, 50], done: 75, speed: 0 });
  });
});
