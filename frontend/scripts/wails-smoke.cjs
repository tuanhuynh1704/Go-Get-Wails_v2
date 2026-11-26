// Optional E2E test against a clean `wails dev` instance, using a real Go backend.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.GOGET_PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const url = process.env.GOGET_WAILS_URL || 'http://localhost:34115';
  assert(['localhost', '127.0.0.1'].includes(new URL(url).hostname), 'use a local Wails development instance');
  const tag = `goget-e2e-${crypto.randomBytes(8).toString('hex')}`;
  const payload = Buffer.alloc(256 * 1024, 'GoGet Wails bridge\n');
  const segmentedPayload = Buffer.alloc(4 * 1024 * 1024 + 13);
  for (let index = 0; index < segmentedPayload.length; index++) segmentedPayload[index] = (index * 31 + Math.floor(index / 65536)) % 251;
  const seen = [];
  const files = new Set();
  const errors = [];
  let browser, downloadDir;
  const server = http.createServer((request, response) => {
    const name = request.url.split('/').pop();
    seen.push({ url: request.url, method: request.method, range: request.headers.range, ifRange: request.headers['if-range'] });
    if (request.url.startsWith('/error/')) return response.writeHead(404).end('not found');
    if (request.url.startsWith('/range/') || request.url.startsWith('/ignored/')) {
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
      let start = 0, end = segmentedPayload.length - 1, status = 200;
      const ignore = request.url.startsWith('/ignored/') && request.headers.range !== 'bytes=0-0';
      if (range && !ignore) { start = Number(range[1]); end = Number(range[2]); status = 206; }
      response.writeHead(status, {
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes', ETag: '"wails-v02"',
        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${segmentedPayload.length}` } : {}),
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      if (request.method === 'HEAD') return response.end();
      if (end === start) return response.end(segmentedPayload.subarray(start, end + 1));
      response.flushHeaders();
      let cursor = start;
      const timer = setInterval(() => {
        const next = Math.min(cursor + 64 * 1024, end + 1);
        response.write(segmentedPayload.subarray(cursor, next));
        cursor = next;
        if (cursor > end) { clearInterval(timer); response.end(); }
      }, 25);
      response.on('close', () => clearInterval(timer));
      return;
    }
    const slow = request.url.startsWith('/slow/');
    response.writeHead(200, {
      'Content-Length': slow ? 8 * 1024 * 1024 : payload.length,
      'Content-Disposition': `attachment; filename="${name}"`,
    });
    if (request.method === 'HEAD') return response.end();
    if (!slow) return response.end(payload);
    response.flushHeaders();
    let sent = 0;
    const timer = setInterval(() => {
      response.write(payload.subarray(0, 64 * 1024));
      sent += 64 * 1024;
      if (sent >= 8 * 1024 * 1024) { clearInterval(timer); response.end(); }
    }, 40);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    const output = path.join(__dirname, '..', 'coverage', 'wails');
    await fs.mkdir(output, { recursive: true });
    browser = await chromium.launch({ headless: true, executablePath: process.env.GOGET_BROWSER_EXECUTABLE || undefined });
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    page.on('pageerror', (error) => errors.push(error.stack || error.message));
    await page.goto(url);
    await page.getByText('Đã kết nối', { exact: true }).waitFor();
    const initial = await page.evaluate(() => window.go.main.App.ListTasks());
    assert(!initial.tasks.some((task) => ['queued', 'probing', 'downloading'].includes(task.status)), 'stop existing downloads before running E2E');
    downloadDir = (await page.evaluate(() => window.go.main.App.GetSettings())).downloadDir;
    await page.evaluate(() => {
      window.__transferProgress = [];
      window.runtime.EventsOn('tasks:progress', (batch) => window.__transferProgress.push(...batch.items));
    });
    const add = async (urls, segments = 8) => {
      await page.getByRole('button', { name: 'Thêm URL', exact: true }).click();
      await page.getByLabel('URL tải xuống', { exact: true }).fill(urls.join('\n'));
      await page.getByLabel('Số đoạn', { exact: true }).fill(String(segments));
      await page.getByRole('button', { name: 'Bắt đầu tải', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    };
    const waitStatus = async (name, status) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const snapshot = await page.evaluate(() => window.go.main.App.ListTasks());
        const task = snapshot.tasks.find((item) => item.fileName === name && item.status === status);
        if (task) return task;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`task ${name} did not reach ${status}`);
    };
    const complete = `${tag}-complete.bin`, slow = `${tag}-slow.bin`;
    files.add(complete); files.add(slow);
    await add([`http://127.0.0.1:${port}/complete/${complete}`, `http://127.0.0.1:${port}/slow/${slow}`]);
    const singleTask = await waitStatus(complete, 'completed');
    assert.equal(singleTask.segCount, 1, 'small files must use one stream');
    const content = await fs.readFile(path.join(downloadDir, complete));
    assert.equal(crypto.createHash('sha256').update(content).digest('hex'), crypto.createHash('sha256').update(payload).digest('hex'));
    await page.getByRole('article', { name: complete, exact: true }).getByText('Hoàn tất', { exact: true }).waitFor();
    await waitStatus(slow, 'downloading');
    await page.getByRole('button', { name: `Hủy tải ${slow}`, exact: true }).click();
    await waitStatus(slow, 'canceled');
    const denial = await page.evaluate(async ({ url, saveDir }) => {
      try { await window.go.main.App.AddURLs({ urls: [url], saveDir }); return 'unexpected success'; }
      catch (error) { return String(error); }
    }, { url: `http://127.0.0.1:${port}/denied.bin`, saveDir: os.tmpdir() });
    assert.match(denial, /E_DIRECTORY/);
    const invalidSegments = await page.evaluate(async (url) => {
      try { await window.go.main.App.AddURLs({ urls: [url], segments: 33 }); return 'unexpected success'; }
      catch (error) { return String(error); }
    }, `http://127.0.0.1:${port}/invalid.bin`);
    assert.match(invalidSegments, /E_INPUT/);
    const batch = Array.from({ length: 5 }, (_, index) => `${tag}-cancel-${index}.bin`);
    batch.forEach((name) => files.add(name));
    await add(batch.map((name) => `http://127.0.0.1:${port}/slow/${name}`));
    await page.getByRole('button', { name: 'Hủy tất cả', exact: true }).click();
    await Promise.all(batch.map((name) => waitStatus(name, 'canceled')));
    assert(new Set(seen.filter((request) => batch.some((name) => request.url.endsWith(name))).map((request) => request.url)).size <= 3, 'queued jobs started during CancelAll');
    const failed = `${tag}-error.bin`;
    files.add(failed);
    await add([`http://127.0.0.1:${port}/error/${failed}`]);
    await waitStatus(failed, 'failed');
    await page.getByRole('article', { name: failed, exact: true }).getByText(/HTTP 404/).waitFor();
    const segmented = `${tag}-segmented.bin`, ignored = `${tag}-fallback.bin`;
    files.add(segmented); files.add(ignored);
    await add([`http://127.0.0.1:${port}/range/${segmented}`], 3);
    const segmentedTask = await waitStatus(segmented, 'completed');
    assert.equal(segmentedTask.segCount, 3);
    assert.deepEqual(segmentedTask.segs, [100, 100, 100]);
    assert.equal(segmentedTask.speed, 0);
    assert.equal(segmentedTask.etaSec, 0);
    const progress = await page.evaluate((id) => window.__transferProgress.filter((item) => item.id === id), segmentedTask.id);
    assert(progress.some((item) => item.speed > 0 && item.etaSec >= 0 && item.segs.length === 3), 'real segment speed/ETA must reach the UI event bridge');
    const detail = await page.evaluate((id) => window.go.main.App.GetTaskDetail(id), segmentedTask.id);
    assert.equal(detail.segments.length, 3);
    assert.equal(detail.segments.reduce((sum, segment) => sum + segment.done, 0), segmentedPayload.length);
    assert.equal(detail.segments[0].start, 0);
    assert.equal(detail.segments.at(-1).end, segmentedPayload.length - 1);
    const actualRanges = seen.filter((request) => request.url.endsWith(segmented) && request.range && request.range !== 'bytes=0-0');
    assert.equal(actualRanges.length, 3, 'expected three real parallel ranged transfers');
    actualRanges.forEach((request) => assert.equal(request.ifRange, '"wails-v02"'));
    await page.getByRole('button', { name: `Chi tiết tải ${segmented}`, exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('group', { name: 'Chi tiết đoạn 3', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'segment-detail.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await add([`http://127.0.0.1:${port}/ignored/${ignored}`], 3);
    const fallbackTask = await waitStatus(ignored, 'completed');
    assert.equal(fallbackTask.segCount, 1, 'ignored Range must restart in single-stream mode');
    for (const name of [segmented, ignored]) {
      const content = await fs.readFile(path.join(downloadDir, name));
      assert.equal(crypto.createHash('sha256').update(content).digest('hex'), crypto.createHash('sha256').update(segmentedPayload).digest('hex'), `${name} checksum`);
    }
    const rangeCanceled = `${tag}-range-canceled.bin`;
    files.add(rangeCanceled);
    await add([`http://127.0.0.1:${port}/range/${rangeCanceled}`], 3);
    await page.waitForFunction(async (name) => {
      const snapshot = await window.go.main.App.ListTasks();
      return snapshot.tasks.some((task) => task.fileName === name && task.status === 'downloading' && task.done > 0 && task.segCount === 3);
    }, rangeCanceled);
    await page.getByRole('button', { name: `Hủy tải ${rangeCanceled}`, exact: true }).click();
    await waitStatus(rangeCanceled, 'canceled');
    for (const name of files) {
      if (![complete, segmented, ignored].includes(name)) await assert.rejects(fs.stat(path.join(downloadDir, name)), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(downloadDir, name + '.goget')), { code: 'ENOENT' });
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'real-bridge.png'), fullPage: true });
    console.log('PASS: real Go bridge, three parallel ranges, If-Range, detail, ignored-Range fallback, SHA-256, completion/error events, cancel/CancelAll, input/directory rejection, cleanup, no page errors');
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (downloadDir) for (const name of files) {
      await fs.rm(path.join(downloadDir, name), { force: true });
      await fs.rm(path.join(downloadDir, name + '.goget'), { force: true });
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
