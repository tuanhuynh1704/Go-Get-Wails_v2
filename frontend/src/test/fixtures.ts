import type { Settings, Stats, Task } from '../lib/types';

export const settings: Settings = { downloadDir: 'C:\\Downloads\\GoGet', maxConcurrentFiles: 3, segmentsPerFile: 8 };
export const emptyStats: Stats = { globalSpeed: 0, active: 0, queued: 0 };
export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1', url: 'https://example.com/tai-lieu.pdf', fileName: 'tài-liệu.pdf',
    saveDir: settings.downloadDir, status: 'downloading', done: 25, total: 100,
    speed: 0, etaSec: -1, segCount: 1, segs: [25], resumable: false, createdAt: 100,
    ...overrides,
  };
}
