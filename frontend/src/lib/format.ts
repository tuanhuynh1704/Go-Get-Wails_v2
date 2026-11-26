const decimal = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Chưa rõ';
  if (bytes === 0) return '0 B';
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${decimal.format(bytes / 1024 ** Math.max(0, unit))} ${['B', 'KB', 'MB', 'GB', 'TB'][Math.max(0, unit)]}`;
}

export function formatSpeed(speed: number): string {
  return `${formatBytes(Number.isFinite(speed) ? Math.max(0, speed) : 0)}/s`;
}

export function formatETA(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Đang tính';
  if (seconds < 1) return 'Sắp xong';
  if (seconds < 60) return `${integer.format(Math.ceil(seconds))} giây`;
  if (seconds < 3600) return `${integer.format(Math.ceil(seconds / 60))} phút`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return minutes === 60 ? `${integer.format(hours + 1)} giờ` : `${integer.format(hours)} giờ${minutes ? ` ${minutes} phút` : ''}`;
}

export function percent(done: number, total: number): number | undefined {
  if (!Number.isFinite(total) || total <= 0) return undefined;
  return Math.min(100, Math.max(0, Math.floor((Math.max(0, done) / total) * 100)));
}

export function sourceHost(url: string): string {
  try { return new URL(url).hostname; } catch { return 'Nguồn tải'; }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Có lỗi xảy ra. Vui lòng thử lại.';
}
