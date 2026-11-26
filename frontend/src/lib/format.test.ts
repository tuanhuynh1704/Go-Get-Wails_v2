import { formatBytes, formatETA, formatSpeed, percent, sourceHost } from './format';

describe('download formatting', () => {
  it('distinguishes unknown totals from empty files', () => {
    expect(formatBytes(-1)).toBe('Chưa rõ');
    expect(formatBytes(Number.NaN)).toBe('Chưa rõ');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(percent(1024, -1)).toBeUndefined();
    expect(percent(0, 0)).toBeUndefined();
  });
  it('clamps percentages and formats unknown ETA without invalid numbers', () => {
    expect(percent(105, 100)).toBe(100);
    expect(percent(-5, 100)).toBe(0);
    expect(formatETA(-1)).toBe('Đang tính');
    expect(formatETA(0)).toBe('Sắp xong');
    expect(formatETA(61)).toBe('2 phút');
    expect(formatETA(7199)).toBe('2 giờ');
    expect(formatSpeed(0)).toBe('0 B/s');
  });
  it('uses source hosts without exposing URL credentials or query tokens', () => {
    expect(sourceHost('https://user:password@example.com/file?token=secret')).toBe('example.com');
    expect(sourceHost('not a URL')).toBe('Nguồn tải');
  });
});
