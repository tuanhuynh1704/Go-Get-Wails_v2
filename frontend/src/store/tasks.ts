import { create } from 'zustand';
import { isTerminal, type BackendEvent, type Filter, type Settings, type Snapshot, type Stats, type Task } from '../lib/types';

type FilterIDs = Record<Filter, string[]>;
interface TaskData {
  tasks: Record<string, Task>;
  order: string[];
  filterIDs: FilterIDs;
  stats: Stats;
}

export interface TaskStore extends TaskData {
  connection: 'connecting' | 'connected' | 'error';
  connectionError: string | null;
  settings: Settings | null;
  beginConnection(): void;
  failConnection(message: string): void;
  loadSnapshot(snapshot: Snapshot, settings: Settings, buffered: BackendEvent[]): void;
  applyEvent(event: BackendEvent): void;
}

function filters(tasks: Record<string, Task>, order: string[]): FilterIDs {
  const result: FilterIDs = { all: order, downloading: [], completed: [], failed: [] };
  for (const id of order) {
    const status = tasks[id].status;
    if (!isTerminal(status)) result.downloading.push(id);
    else if (status === 'completed') result.completed.push(id);
    else if (status === 'failed') result.failed.push(id);
  }
  return result;
}

function mergeTask(current: Task | undefined, incoming: Task): Task {
  if (!current) return isTerminal(incoming.status) ? { ...incoming, speed: 0 } : incoming;
  // v0.1 has no resume/retry: a terminal state cannot become active again.
  if (isTerminal(current.status)) return current;
  const rank = { queued: 0, probing: 1, downloading: 2, completed: 3, failed: 3, canceled: 3 };
  if (rank[incoming.status] < rank[current.status]) return current;
  if (incoming.status === current.status && incoming.done < current.done) return current;
  return {
    ...incoming,
    done: Math.max(current.done, incoming.done),
    total: incoming.total < 0 && current.total >= 0 ? current.total : incoming.total,
    speed: isTerminal(incoming.status) ? 0 : incoming.speed,
  };
}

function applyEvent(data: TaskData, event: BackendEvent): TaskData {
  if (event.type === 'stats:update') return { ...data, stats: event.stats };
  if (event.type === 'tasks:progress') {
    const tasks = { ...data.tasks };
    for (const item of event.items) {
      const current = tasks[item.id];
      if (!current || isTerminal(current.status) || item.done < current.done) continue;
      tasks[item.id] = {
        ...current, done: item.done, total: item.total < 0 && current.total >= 0 ? current.total : item.total,
        speed: item.speed, etaSec: item.etaSec,
      };
    }
    return { ...data, tasks };
  }
  const incoming = event.task;
  const current = data.tasks[incoming.id];
  const merged = mergeTask(current, incoming);
  if (merged === current) return data;
  const tasks = { ...data.tasks, [incoming.id]: merged };
  const order = current ? data.order : [...data.order, incoming.id].sort((a, b) => tasks[b].createdAt - tasks[a].createdAt);
  const membershipChanged = !current || current.status !== merged.status;
  return { ...data, tasks, order, filterIDs: membershipChanged ? filters(tasks, order) : data.filterIDs };
}

function snapshotData(snapshot: Snapshot): TaskData {
  const tasks: Record<string, Task> = {};
  for (const task of snapshot.tasks) tasks[task.id] = mergeTask(tasks[task.id], task);
  const order = Object.keys(tasks).sort((a, b) => tasks[b].createdAt - tasks[a].createdAt);
  return { tasks, order, filterIDs: filters(tasks, order), stats: snapshot.stats };
}

export const createTaskStore = () => create<TaskStore>((set) => ({
  tasks: {}, order: [], filterIDs: { all: [], downloading: [], completed: [], failed: [] },
  stats: { globalSpeed: 0, active: 0, queued: 0 },
  connection: 'connecting', connectionError: null, settings: null,
  beginConnection: () => set({ connection: 'connecting', connectionError: null }),
  failConnection: (connectionError) => set({ connection: 'error', connectionError }),
  loadSnapshot: (snapshot, settings, buffered) => set({
    ...buffered.reduce(applyEvent, snapshotData(snapshot)),
    settings, connection: 'connected', connectionError: null,
  }),
  applyEvent: (event) => set((state) => applyEvent(state, event)),
}));

export const useTaskStore = createTaskStore();
