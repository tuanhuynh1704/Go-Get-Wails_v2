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
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('keeps unknown speed %s distinct from a stopped transfer', (speed) => {
    expect(formatSpeed(speed)).toBe('Chưa rõ');
  });
  it.each([[0, '0 B/s'], [1, '1 B/s'], [1024, '1 KB/s'], [1536, '1,5 KB/s'], [1024 ** 4, '1 TB/s']])('formats actual speed %s', (speed, expected) => {
    expect(formatSpeed(Number(speed))).toBe(expected);
  });
  it.each([[0, 'Sắp xong'], [1, '1 giây'], [59, '59 giây'], [60, '1 phút'], [3599, '60 phút'], [3600, '1 giờ'], [3660, '1 giờ 1 phút'], [86400, '24 giờ']])('formats ETA boundary %s', (seconds, expected) => {
    expect(formatETA(Number(seconds))).toBe(expected);
  });
  it('handles non-finite ETA and progress safely', () => {
    expect(formatETA(Number.NaN)).toBe('Đang tính');
    expect(formatETA(Number.POSITIVE_INFINITY)).toBe('Đang tính');
    expect(percent(Number.NaN, 100)).toBeUndefined();
    expect(percent(Number.POSITIVE_INFINITY, 100)).toBeUndefined();
  });
});
