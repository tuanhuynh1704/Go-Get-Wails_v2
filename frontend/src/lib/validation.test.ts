import { validateURLs } from './validation';

describe('bulk URL validation', () => {
  it('accepts exactly 100 HTTP(S) URLs and preserves duplicates and Unicode', () => {
    const urls = Array.from({ length: 100 }, (_, index) => index % 2 ? 'http://example.com/tài-liệu.pdf' : 'https://example.com/a');
    expect(validateURLs(`\n ${urls.join(' \r\n ')} \n`)).toEqual({ urls, errors: [] });
  });

  it.each(['https:example.com/file', 'https:/example.com', 'https://example.com\\file', 'javascript:alert(1)', 'file:///tmp/a', 'https://', 'https://example.com/a b'])('rejects malformed or non-HTTP(S) URL %s', (url) => {
    expect(validateURLs(url).errors).toEqual(['Dòng 1: nhập URL http:// hoặc https:// hợp lệ.']);
  });
});
