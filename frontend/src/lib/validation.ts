export const MAX_URLS = 100;

export function urlLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function validateURLs(text: string): { urls: string[]; errors: string[] } {
  const urls = urlLines(text);
  if (!urls.length) return { urls, errors: ['Nhập ít nhất một URL để bắt đầu tải.'] };
  if (urls.length > MAX_URLS) return { urls, errors: [`Chỉ thêm tối đa ${MAX_URLS} URL mỗi lần.`] };
  const errors: string[] = [];
  urls.forEach((url, index) => {
    try {
      const parsed = new URL(url);
      if (!/^https?:\/\//i.test(url) || !['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || /[\s\\]/.test(url)) throw new Error();
    } catch {
      errors.push(`Dòng ${index + 1}: nhập URL http:// hoặc https:// hợp lệ.`);
    }
  });
  return { urls, errors };
}
