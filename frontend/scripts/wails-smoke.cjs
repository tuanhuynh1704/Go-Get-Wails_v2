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
  const seen = [];
  const files = new Set();
  const errors = [];
  let browser, downloadDir;
  const server = http.createServer((request, response) => {
    const name = request.url.split('/').pop();
    seen.push(request.url);
    if (request.url.startsWith('/error/')) return response.writeHead(404).end('not found');
    const slow = request.url.startsWith('/slow/');
    response.writeHead(200, {
      'Content-Length': slow ? 8 * 1024 * 1024 : payload.length,
      'Content-Disposition': `attachment; filename="${name}"`,
    });
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
    browser = await chromium.launch({ headless: true, executablePath: process.env.GOGET_BROWSER_EXECUTABLE || undefined });
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText('Đã kết nối', { exact: true }).waitFor();
    const initial = await page.evaluate(() => window.go.main.App.ListTasks());
    assert(!initial.tasks.some((task) => ['queued', 'probing', 'downloading'].includes(task.status)), 'stop existing downloads before running E2E');
    downloadDir = (await page.evaluate(() => window.go.main.App.GetSettings())).downloadDir;
    const add = async (urls) => {
      await page.getByRole('button', { name: 'Thêm URL', exact: true }).click();
      await page.getByLabel('URL tải xuống', { exact: true }).fill(urls.join('\n'));
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
    await waitStatus(complete, 'completed');
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
    const batch = Array.from({ length: 5 }, (_, index) => `${tag}-cancel-${index}.bin`);
    batch.forEach((name) => files.add(name));
    await add(batch.map((name) => `http://127.0.0.1:${port}/slow/${name}`));
    await page.getByRole('button', { name: 'Hủy tất cả', exact: true }).click();
    await Promise.all(batch.map((name) => waitStatus(name, 'canceled')));
    assert(seen.filter((request) => batch.some((name) => request.endsWith(name))).length <= 3, 'queued jobs started during CancelAll');
    const failed = `${tag}-error.bin`;
    files.add(failed);
    await add([`http://127.0.0.1:${port}/error/${failed}`]);
    await waitStatus(failed, 'failed');
    await page.getByRole('article', { name: failed, exact: true }).getByText(/HTTP 404/).waitFor();
    for (const name of files) {
      if (name !== complete) await assert.rejects(fs.stat(path.join(downloadDir, name)), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(downloadDir, name + '.goget')), { code: 'ENOENT' });
    }
    assert.deepEqual(errors, []);
    const output = path.join(__dirname, '..', 'coverage', 'wails');
    await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'real-bridge.png'), fullPage: true });
    console.log('PASS: real Go bridge, bulk add, SHA-256, completion/error events, cancel/CancelAll, directory rejection, cleanup, no page errors');
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
