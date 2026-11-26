// Optional browser verification using an existing Playwright installation and browser.
const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.GOGET_PLAYWRIGHT_MODULE || 'playwright');

async function installBridge(page) {
  await page.addInitScript(() => {
    const listeners = new Map();
    const calls = [];
    const emit = (name, payload) => (listeners.get(name) || []).slice().forEach((callback) => callback(payload));
    const makeTask = (index) => ({
      id: `task-${index}`, url: `https://example.com/files/${index}.pdf`,
      fileName: `Tài liệu dự án ${index} - ${'báo-cáo-'.repeat(index === 0 ? 20 : 1)}.pdf`,
      saveDir: 'C:\\Downloads\\GoGet', status: ['downloading', 'completed', 'failed', 'queued'][index % 4],
      error: index % 4 === 2 ? 'Máy chủ trả về 404. Không tìm thấy tệp được yêu cầu.' : undefined,
      total: index === 0 ? -1 : 1000, done: index % 4 === 1 ? 1000 : 250,
      speed: 0, etaSec: -1, segCount: 1, resumable: false, createdAt: 1000 - index,
    });
    const tasks = Array.from({ length: Number(new URLSearchParams(location.search).get('tasks') || 0) }, (_, index) => makeTask(index));
    const stats = () => ({
      active: tasks.filter((task) => ['probing', 'downloading'].includes(task.status)).length,
      queued: tasks.filter((task) => task.status === 'queued').length,
      globalSpeed: 0,
    });
    const register = (name, callback) => {
      calls.push(`subscribe:${name}`);
      listeners.set(name, [...(listeners.get(name) || []), callback]);
      return () => listeners.set(name, (listeners.get(name) || []).filter((item) => item !== callback));
    };
    const cancel = (task) => {
      if (['completed', 'failed', 'canceled'].includes(task.status)) return;
      task.status = 'canceled';
      emit('task:status', { ...task });
    };
    window.runtime = { EventsOn: register, EventsOnMultiple: register };
    window.__bridge = { calls, emit, tasks, failSnapshot: false };
    window.go = { main: { App: {
      ListTasks: async () => {
        calls.push('snapshot');
        if (window.__bridge.failSnapshot) throw new Error('Mất kết nối thử nghiệm');
        return { tasks: tasks.map((task) => ({ ...task })), stats: stats() };
      },
      GetSettings: async () => ({ downloadDir: 'C:\\Downloads\\GoGet', maxConcurrentFiles: 3, segmentsPerFile: 1 }),
      PickDirectory: async () => { calls.push('picker'); return 'D:\\Thu muc da chon'; },
      AddURLs: async (request) => {
        calls.push({ add: request });
        const result = { ids: [], errors: [] };
        request.urls.forEach((url) => {
          if (url.includes('reject')) { result.errors.push({ url, error: 'URL bị từ chối thử nghiệm' }); return; }
          const task = { ...makeTask(tasks.length), url, id: `added-${tasks.length}`, status: 'queued', createdAt: Date.now(), saveDir: request.saveDir || 'C:\\Downloads\\GoGet' };
          tasks.push(task);
          result.ids.push(task.id);
          emit('task:added', { ...task });
        });
        emit('stats:update', stats());
        return result;
      },
      Cancel: async (id, deleteFile) => {
        calls.push({ cancel: id, deleteFile });
        cancel(tasks.find((task) => task.id === id));
        emit('stats:update', stats());
      },
      CancelAll: async () => { calls.push('cancel-all'); tasks.forEach(cancel); emit('stats:update', stats()); },
    } } };
  });
}

async function textContrast(page) {
  return page.evaluate(() => {
    const rgb = (value) => value.match(/[\d.]+/g).map(Number);
    const luminance = (color) => color.slice(0, 3).map((part) => {
      const value = part / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const failures = new Map();
    document.querySelectorAll('body *').forEach((element) => {
      const text = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim();
      if (!text || element.closest('script, style, button:disabled, [aria-hidden="true"]') || element.getBoundingClientRect().width < 2) return;
      const style = getComputedStyle(element);
      if (style.visibility !== 'visible') return;
      const layers = [];
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) layers.unshift(rgb(getComputedStyle(ancestor).backgroundColor));
      const background = layers.reduce((base, layer) => base.map((value, index) => layer[index] * (layer[3] ?? 1) + value * (1 - (layer[3] ?? 1))), [255, 255, 255]);
      const foregroundLuminance = luminance(rgb(style.color));
      const backgroundLuminance = luminance(background);
      const ratio = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && parseFloat(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) failures.set(`${element.className}|${style.color}`, { class: element.className, text: text.slice(0, 45), ratio: Math.round(ratio * 100) / 100 });
    });
    return [...failures.values()];
  });
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.GOGET_BROWSER_PATH ? { executablePath: process.env.GOGET_BROWSER_PATH } : {}),
  });
  const base = process.env.GOGET_BASE_URL || 'http://127.0.0.1:5173';
  const output = path.resolve(__dirname, '../coverage/browser');
  await mkdir(output, { recursive: true });
  const errors = [];
  const contrast = [];
  const results = [];
  try {
    for (const width of [360, 390, 768, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(`${message.location().url}: ${message.text()}`); });
      await installBridge(page);
      await page.goto(base);
      await page.getByText('Đã kết nối', { exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Bắt đầu với một đường dẫn.' }).waitFor();
      assert(await page.evaluate(() => {
        const calls = window.__bridge.calls;
        const snapshot = calls.indexOf('snapshot');
        return ['task:added', 'task:status', 'tasks:progress', 'stats:update'].every((name) => calls.indexOf(`subscribe:${name}`) < snapshot);
      }), 'Event listeners must register before the snapshot');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Empty state overflows at ${width}px`);
      await page.screenshot({ path: path.join(output, `empty-${width}.png`), fullPage: true });
      contrast.push({ viewport: width, state: 'empty', failures: await textContrast(page) });

      const trigger = page.getByRole('button', { name: 'Thêm URL', exact: true });
      await trigger.click();
      const modal = page.getByRole('dialog');
      const urls = modal.getByRole('textbox', { name: 'URL tải xuống' });
      await urls.waitFor();
      assert(await urls.evaluate((element) => element === document.activeElement));
      await page.keyboard.press('Shift+Tab');
      assert(await modal.getByRole('button', { name: 'Đóng hộp thoại', exact: true }).evaluate((element) => element === document.activeElement));
      await page.keyboard.press('Shift+Tab');
      assert(await modal.getByRole('button', { name: 'Bắt đầu tải' }).evaluate((element) => element === document.activeElement), 'Native dialog must wrap focus');
      await urls.fill('https://example.com/approved.pdf\nhttps://example.com/reject.pdf');
      await modal.getByRole('button', { name: 'Chọn thư mục' }).click();
      await page.getByLabel('Thư mục lưu').filter({ hasText: 'D:\\Thu muc da chon' }).waitFor();
      await page.screenshot({ path: path.join(output, `dialog-${width}.png`), fullPage: true });
      contrast.push({ viewport: width, state: 'dialog', failures: await textContrast(page) });
      await modal.getByRole('button', { name: 'Bắt đầu tải' }).click();
      await modal.getByText('Không thể thêm 1 URL').waitFor();
      assert.equal(await urls.inputValue(), 'https://example.com/reject.pdf');
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'hidden' });
      assert(await trigger.evaluate((element) => element === document.activeElement), 'Escape must return focus');

      await page.goto(`${base}/?tasks=500`);
      await page.getByText('Đã kết nối', { exact: true }).waitFor();
      const region = page.getByRole('region', { name: 'Danh sách tải xuống' });
      await region.waitFor();
      const mounted = await page.getByRole('listitem').count();
      assert(mounted > 0 && mounted < 50, `Expected virtual window, got ${mounted} rows at ${width}px`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Task list overflows at ${width}px`);
      await page.screenshot({ path: path.join(output, `tasks-${width}.png`), fullPage: true });
      contrast.push({ viewport: width, state: 'tasks', failures: await textContrast(page) });
      await region.focus();
      await page.keyboard.press('End');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-posinset') === '500');
      await page.keyboard.press('ArrowUp');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-posinset') === '499');
      await page.keyboard.press('Home');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-posinset') === '1');
      const first = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: /^Tài liệu dự án 0 -/ }) });
      await first.getByRole('button', { name: /^Hủy tải/ }).click();
      await first.getByText('Đã hủy', { exact: true }).waitFor();
      assert(await first.evaluate((element) => element === document.activeElement), 'Cancel must preserve row focus');
      const progressBefore = await first.getByRole('progressbar').getAttribute('aria-valuenow');
      await page.evaluate(() => window.__bridge.emit('tasks:progress', { items: [{ id: 'task-0', done: 999, total: 1000, speed: 100, etaSec: 1, segs: [] }] }));
      assert.equal(await first.getByRole('progressbar').getAttribute('aria-valuenow'), progressBefore);
      await page.getByRole('button', { name: /^Hoàn tất/ }).click();
      assert.equal(await page.locator('.task-row:not(.task-completed)').count(), 0);
      await page.getByRole('button', { name: /^Đang tải/ }).click();
      await page.getByRole('button', { name: 'Hủy tất cả' }).click();
      await page.getByRole('heading', { name: 'Hàng đợi đang thảnh thơi.' }).waitFor();
      assert(await page.getByRole('button', { name: 'Hủy tất cả' }).isDisabled());
      results.push({ viewport: width, virtualRows: mounted, modalKeyboard: 'pass', actions: 'pass', overflow: 'none' });
      await context.close();
    }
    const offline = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    offline.on('pageerror', (error) => errors.push(error.message));
    offline.on('console', (message) => { if (message.type() === 'error') errors.push(`${message.location().url}: ${message.text()}`); });
    await offline.goto(base);
    await offline.getByRole('alert').filter({ hasText: 'Không thể kết nối với GoGet' }).waitFor();
    await offline.getByRole('heading', { name: 'Thư viện đang ngoại tuyến' }).waitFor();
    assert(await offline.getByRole('button', { name: 'Thêm URL', exact: true }).isDisabled());
    await offline.screenshot({ path: path.join(output, 'offline-1280.png'), fullPage: true });
    contrast.push({ viewport: 1280, state: 'offline', failures: await textContrast(offline) });
    await offline.close();
    assert.deepEqual(errors, [], 'Browser raised uncaught page errors');
    const contrastFailures = contrast.filter((result) => result.failures.length);
    console.log(JSON.stringify({ results, pageErrors: errors, contrastFailures, screenshots: output, bridge: 'simulated; native Wails not exercised' }, null, 2));
    assert.deepEqual(contrastFailures, [], 'Rendered text contrast fell below 4.5:1 (3:1 for large text)');
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
