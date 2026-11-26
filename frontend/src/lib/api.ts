import * as bindings from '../../wailsjs/go/main/App';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import type { AddRequest, BackendAPI, BackendEvent, ProgressItem, Snapshot, Stats, Task, TaskStatus } from './types';

type BridgeWindow = Window & {
  go?: { main?: { App?: unknown } };
  runtime?: { EventsOn?: unknown };
};

function requireBridge(): void {
  const bridge = window as BridgeWindow;
  if (!bridge.go?.main?.App || typeof bridge.runtime?.EventsOn !== 'function') {
    throw new Error('Chưa kết nối với GoGet. Hãy mở ứng dụng desktop hoặc chạy Wails rồi thử lại.');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('Dữ liệu từ ứng dụng không hợp lệ.');
  return value as Record<string, unknown>;
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Dữ liệu số từ ứng dụng không hợp lệ.');
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Dữ liệu văn bản từ ứng dụng không hợp lệ.');
  return value;
}

function task(value: unknown): Task {
  const data = record(value);
  const status = text(data.status);
  if (!['queued', 'probing', 'downloading', 'completed', 'failed', 'canceled'].includes(status)) {
    throw new Error('Trạng thái tác vụ không được hỗ trợ.');
  }
  return {
    id: text(data.id), url: text(data.url), fileName: text(data.fileName), saveDir: text(data.saveDir),
    status: status as TaskStatus, error: typeof data.error === 'string' ? data.error : undefined,
    total: number(data.total), done: number(data.done), speed: number(data.speed),
    etaSec: number(data.etaSec), segCount: number(data.segCount), createdAt: number(data.createdAt),
    segs: Array.isArray(data.segs) ? data.segs.map(number) : [],
    resumable: data.resumable === true,
  };
}

function stats(value: unknown): Stats {
  const data = record(value);
  return { globalSpeed: number(data.globalSpeed), active: number(data.active), queued: number(data.queued) };
}

function progress(value: unknown): ProgressItem {
  const data = record(value);
  return {
    id: text(data.id), done: number(data.done), total: number(data.total),
    speed: number(data.speed), etaSec: number(data.etaSec),
    segs: Array.isArray(data.segs) ? data.segs.map(number) : [],
  };
}

// Generated classes are structural at this boundary; UI state never depends on their constructors.
export const api: BackendAPI = {
  async addURLs(request: AddRequest) {
    requireBridge();
    const result = await bindings.AddURLs(request);
    return { ids: result.ids ?? [], errors: result.errors ?? [] };
  },
  async listTasks(): Promise<Snapshot> {
    requireBridge();
    const snapshot = await bindings.ListTasks();
    return { tasks: (snapshot.tasks ?? []).map(task), stats: stats(snapshot.stats) };
  },
  async getTaskDetail(id) {
    requireBridge();
    const detail = await bindings.GetTaskDetail(id);
    if (detail.task.id !== id) throw new Error('Chi tiết tác vụ không khớp với yêu cầu.');
    return {
      task: task(detail.task),
      segments: (detail.segments ?? []).map((value: unknown) => {
        const data = record(value);
        return { index: number(data.index), start: number(data.start), end: number(data.end), done: number(data.done), status: text(data.status) };
      }),
    };
  },
  async cancel(id, deleteFile) { requireBridge(); await bindings.Cancel(id, deleteFile); },
  async cancelAll() { requireBridge(); await bindings.CancelAll(); },
  async pickDirectory() { requireBridge(); return bindings.PickDirectory(); },
  async getSettings() { requireBridge(); return bindings.GetSettings(); },
  subscribe(onEvent, onError) {
    requireBridge();
    const stops: (() => void)[] = [];
    const listen = (name: BackendEvent['type'], decode: (payload: unknown) => BackendEvent) => {
      stops.push(EventsOn(name, (payload: unknown) => {
        try { onEvent(decode(payload)); } catch (error) { onError(error); }
      }));
    };
    try {
      listen('task:added', (value) => ({ type: 'task:added', task: task(value) }));
      listen('task:status', (value) => ({ type: 'task:status', task: task(value) }));
      listen('tasks:progress', (value) => {
        const items = record(value).items;
        if (!Array.isArray(items)) throw new Error('Dữ liệu tiến trình không hợp lệ.');
        return { type: 'tasks:progress', items: items.map(progress) };
      });
      listen('stats:update', (value) => ({ type: 'stats:update', stats: stats(value) }));
    } catch (error) {
      stops.forEach((stop) => stop());
      throw error;
    }
    return () => stops.forEach((stop) => stop());
  },
};
