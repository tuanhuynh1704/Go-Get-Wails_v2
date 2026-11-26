export type TaskStatus = 'queued' | 'probing' | 'downloading' | 'completed' | 'failed' | 'canceled';

export interface Task {
  id: string;
  url: string;
  fileName: string;
  saveDir: string;
  status: TaskStatus;
  error?: string;
  total: number;
  done: number;
  speed: number;
  etaSec: number;
  segCount: number;
  segs: number[];
  resumable: boolean;
  createdAt: number;
}

export interface Settings {
  downloadDir: string;
  maxConcurrentFiles: number;
  segmentsPerFile: number;
}

export interface Stats { globalSpeed: number; active: number; queued: number }
export interface Snapshot { tasks: Task[]; stats: Stats }
export interface AddRequest { urls: string[]; saveDir: string; segments: number }
export interface Segment { index: number; start: number; end: number; done: number; status: string }
export interface TaskDetail { task: Task; segments: Segment[] }
export interface AddResult { ids: string[]; errors: { url: string; error: string }[] }
export interface ProgressItem {
  id: string;
  done: number;
  total: number;
  speed: number;
  etaSec: number;
  segs: number[];
}

export type BackendEvent =
  | { type: 'task:added' | 'task:status'; task: Task }
  | { type: 'tasks:progress'; items: ProgressItem[] }
  | { type: 'stats:update'; stats: Stats };

export interface BackendAPI {
  addURLs(request: AddRequest): Promise<AddResult>;
  listTasks(): Promise<Snapshot>;
  getTaskDetail(id: string): Promise<TaskDetail>;
  cancel(id: string, deleteFile: boolean): Promise<void>;
  cancelAll(): Promise<void>;
  pickDirectory(): Promise<string>;
  getSettings(): Promise<Settings>;
  subscribe(onEvent: (event: BackendEvent) => void, onError: (error: unknown) => void): () => void;
}

export type Filter = 'all' | 'downloading' | 'completed' | 'failed';

export const isTerminal = (status: TaskStatus) =>
  status === 'completed' || status === 'failed' || status === 'canceled';

export const statusLabels: Record<TaskStatus, string> = {
  queued: 'Trong hàng đợi',
  probing: 'Đang kết nối',
  downloading: 'Đang tải',
  completed: 'Hoàn tất',
  failed: 'Thất bại',
  canceled: 'Đã hủy',
};
