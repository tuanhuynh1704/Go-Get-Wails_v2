// Optional browser verification using an existing Playwright installation and browser.
const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.GOGET_PLAYWRIGHT_MODULE || 'playwright');

const categories = [
  { id: 'doc', label: 'Tài liệu', extension: 'pdf', empty: 'Chưa có tài liệu.' },
  { id: 'video', label: 'Video', extension: 'mp4', empty: 'Chưa có video.' },
  { id: 'music', label: 'Nhạc', extension: 'mp3', empty: 'Chưa có tệp nhạc.' },
  { id: 'archive', label: 'File nén', extension: 'zip', empty: 'Chưa có file nén.' },
  { id: 'other', label: 'Khác', extension: 'bin', empty: 'Chưa có tệp khác.' },
];

async function installBridge(page) {
  await page.addInitScript((categories) => {
    const listeners = new Map();
    const calls = [];
    const emit = (name, payload) => (listeners.get(name) || []).slice().forEach((callback) => callback(payload));
    const makeTask = (index) => ({
      id: `task-${index}`, url: `https://example.com/files/${index}.bin`,
      fileName: `Tệp dự án ${index} - ${'báo-cáo-'.repeat(index === 0 ? 20 : 1)}.${categories[index % categories.length].extension}`,
      category: categories[index % categories.length].id,
      saveDir: 'C:\\Downloads\\GoGet', status: ['downloading', 'completed', 'failed', 'queued'][index % 4],
      error: index % 4 === 2 ? 'Máy chủ trả về 404. Không tìm thấy tệp được yêu cầu.' : undefined,
      total: index === 4 ? -1 : 8000, done: index % 4 === 1 ? 8000 : index % 4 === 3 ? 0 : 4000,
      speed: index % 4 === 0 ? 1572864 : 0, etaSec: index % 4 === 0 ? 61 : -1,
      segCount: index % 4 === 3 ? 0 : index === 4 ? 1 : 8,
      segs: index % 4 === 3 ? [] : index === 4 ? [0] : index % 4 === 1 ? Array(8).fill(100) : [100, 75, 50, 25, 0, 40, 80, 30],
      resumable: index % 4 !== 3 && index !== 4, createdAt: 1000 - index,
    });
    const tasks = Array.from({ length: Number(new URLSearchParams(location.search).get('tasks') || 0) }, (_, index) => makeTask(index));
    const stats = () => ({
      active: tasks.filter((task) => ['probing', 'downloading'].includes(task.status)).length,
      queued: tasks.filter((task) => task.status === 'queued').length,
      globalSpeed: tasks.reduce((sum, task) => sum + task.speed, 0),
    });
    const register = (name, callback) => {
      calls.push(`subscribe:${name}`);
      listeners.set(name, [...(listeners.get(name) || []), callback]);
      return () => listeners.set(name, (listeners.get(name) || []).filter((item) => item !== callback));
    };
    const cancel = (task) => {
      if (['completed', 'failed', 'canceled'].includes(task.status)) return;
      task.status = 'canceled';
      task.speed = 0;
      task.etaSec = -1;
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
      GetSettings: async () => ({ downloadDir: 'C:\\Downloads\\GoGet', maxConcurrentFiles: 3, segmentsPerFile: 8 }),
      GetTaskDetail: async (id) => {
        calls.push({ detail: id });
        const task = tasks.find((item) => item.id === id);
        if (!task) throw new Error('Không tìm thấy tác vụ');
        return { task: { ...task }, segments: task.segs.map((value, index) => ({ index, start: index * 1000, end: task.total < 0 ? -1 : (index + 1) * 1000 - 1, done: task.total < 0 ? task.done : value * 10, status: value === 100 ? 'completed' : task.status })) };
      },
      PickDirectory: async () => { calls.push('picker'); return 'D:\\Thu muc da chon'; },
      AddURLs: async (request) => {
        calls.push({ add: request });
        if (!Number.isInteger(request.segments) || request.segments < 1 || request.segments > 32) throw new Error('Số đoạn không hợp lệ');
        const result = { ids: [], errors: [] };
        request.urls.forEach((url) => {
          if (url.includes('reject')) { result.errors.push({ url, error: 'URL bị từ chối thử nghiệm' }); return; }
          const fileName = new URL(url).pathname.split('/').pop() || 'download';
          const category = categories.find((item) => fileName.toLowerCase().endsWith(`.${item.extension}`))?.id || 'other';
          const task = { ...makeTask(tasks.length), url, fileName, category, id: `added-${tasks.length}`, status: 'queued', createdAt: Date.now(), saveDir: request.saveDir || 'C:\\Downloads\\GoGet', done: 0, total: -1, speed: 0, etaSec: -1, segs: [], segCount: 0, resumable: false };
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
  }, categories);
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
    ...((process.env.GOGET_BROWSER_EXECUTABLE || process.env.GOGET_BROWSER_PATH) ? { executablePath: process.env.GOGET_BROWSER_EXECUTABLE || process.env.GOGET_BROWSER_PATH } : {}),
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
      const categoryNav = page.getByRole('navigation', { name: 'Lọc theo loại tệp' });
      for (const category of categories) {
        const button = categoryNav.getByRole('button', { name: new RegExp(`^${category.label}`) });
        await button.click();
        await page.getByRole('heading', { name: category.empty, exact: true }).waitFor();
        assert.equal(await button.getAttribute('aria-current'), 'page');
        assert.equal(await button.locator('.filter-count').textContent(), '0');
        assert.equal(await page.locator('.library-count').textContent(), '0');
        assert(await page.getByRole('button', { name: 'Thêm URL mới', exact: true }).isEnabled());
        if (category.id === 'doc') await page.screenshot({ path: path.join(output, `category-empty-${width}.png`), fullPage: true });
      }
      await page.getByRole('button', { name: /^Tất cả/ }).click();

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
      const segments = modal.getByRole('spinbutton', { name: 'Số đoạn', exact: true });
      assert.equal(await segments.inputValue(), '8', 'Segment default must come from settings');
      await segments.fill('33');
      await modal.getByRole('button', { name: 'Bắt đầu tải' }).click();
      await modal.getByRole('alert').filter({ hasText: 'Số đoạn phải là số nguyên từ 1 đến 32' }).waitFor();
      assert.equal(await page.evaluate(() => window.__bridge.calls.filter((call) => call.add).length), 0, 'Invalid segment input must not reach the bridge');
      await segments.fill('32');
      await modal.getByRole('button', { name: 'Chọn thư mục' }).click();
      await page.getByLabel('Thư mục lưu').filter({ hasText: 'D:\\Thu muc da chon' }).waitFor();
      await page.screenshot({ path: path.join(output, `dialog-${width}.png`), fullPage: true });
      contrast.push({ viewport: width, state: 'dialog', failures: await textContrast(page) });
      await modal.getByRole('button', { name: 'Bắt đầu tải' }).click();
      await modal.getByText('Không thể thêm 1 URL').waitFor();
      assert.equal(await page.evaluate(() => window.__bridge.calls.find((call) => call.add).add.segments), 32);
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
      const first = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: /^Tệp dự án 0 -/ }) });
      assert.match(await first.locator('.task-timing').textContent(), /1,5 MB\/s.*ETA 2 phút/);
      assert.equal(await first.locator('.segment-cell').count(), 8);
      assert.equal(await first.getByRole('progressbar', { name: /^Đoạn 2 của/ }).getAttribute('aria-valuenow'), '75');
      assert.match(await page.locator('.statusbar').textContent(), /Tổng: 187,5 MB\/s.*Đang tải: 125.*Hàng đợi: 125/);
      assert.equal(await page.evaluate(() => window.__bridge.calls.filter((call) => call.detail).length), 0, 'Closed detail must not fetch');
      const detailTrigger = first.getByRole('button', { name: /^Chi tiết tải/ });
      await detailTrigger.click();
      const detail = page.getByRole('dialog', { name: 'Chi tiết tải xuống' });
      await detail.getByRole('group', { name: 'Chi tiết đoạn 8', exact: true }).waitFor();
      assert.match(await detail.getByRole('group', { name: 'Chi tiết đoạn 1', exact: true }).textContent(), /Byte 0 – 999.*1.000 B \/ 1.000 B.*100%/);
      assert.equal(await detail.locator('.segment-cell').count(), 8);
      await page.keyboard.press('Shift+Tab');
      assert(await detail.getByRole('button', { name: 'Đóng', exact: true }).evaluate((element) => element === document.activeElement));
      await page.keyboard.press('Tab');
      assert(await detail.getByRole('button', { name: 'Đóng chi tiết', exact: true }).evaluate((element) => element === document.activeElement));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Detail overflows at ${width}px`);
      await page.screenshot({ path: path.join(output, `detail-${width}.png`), fullPage: true });
      contrast.push({ viewport: width, state: 'detail', failures: await textContrast(page) });
      await detail.getByRole('button', { name: 'Làm mới', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `detail-end-${width}.png`), fullPage: true });
      await page.keyboard.press('Escape');
      await detail.waitFor({ state: 'hidden' });
      assert(await detailTrigger.evaluate((element) => element === document.activeElement), 'Detail must return focus');
      await page.evaluate(() => window.__bridge.emit('tasks:progress', { items: [{ id: 'task-0', done: 5000, total: 8000, speed: 2097152, etaSec: 10, segs: [100, 100, 80, 50, 10, 50, 80, 30] }] }));
      await page.waitForFunction(() => document.querySelector('.task-row .segment-cell:nth-child(2)')?.getAttribute('aria-valuenow') === '100');
      assert.match(await first.locator('.task-timing').textContent(), /2 MB\/s.*ETA 10 giây/);
      assert.equal(await page.evaluate(() => window.__bridge.calls.filter((call) => call.detail).length), 1, 'Progress must not fetch closed detail');
      const progressBeforeCorrection = await first.getByRole('progressbar', { name: /^Tiến trình/ }).getAttribute('aria-valuenow');
      const categoryWindows = {};
      for (const category of categories) {
        const button = categoryNav.getByRole('button', { name: new RegExp(`^${category.label}`) });
        await button.click();
        await page.getByRole('heading', { name: category.label, exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector('[aria-setsize]')?.getAttribute('aria-setsize') === '100');
        assert.equal(await button.getAttribute('aria-current'), 'page');
        assert.equal(await button.locator('.filter-count').textContent(), '100');
        assert.equal(await page.locator('.library-count').textContent(), '100');
        const files = await page.locator('.task-row h3').allTextContents();
        assert(files.length > 0 && files.length < 50, `Category ${category.id} must remain virtualized at ${width}px`);
        assert(files.every((file) => file.endsWith(`.${category.extension}`)), `Category ${category.id} contains the wrong files`);
        const statuses = await page.locator('.task-row').evaluateAll((rows) => [...new Set(rows.map((row) => row.className.match(/task-(downloading|completed|failed|queued)\b/)[1]))].sort());
        assert.deepEqual(statuses, ['completed', 'downloading', 'failed', 'queued'], 'Category filters must include every status');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Category ${category.id} overflows at ${width}px`);
        categoryWindows[category.id] = files.length;
        if (category.id === 'doc') {
          await page.screenshot({ path: path.join(output, `category-doc-${width}.png`), fullPage: true });
          contrast.push({ viewport: width, state: 'category-doc', failures: await textContrast(page) });
        }
      }
      await categoryNav.getByRole('button', { name: /^Tài liệu/ }).click();
      const correctedName = 'Tên máy chủ xác nhận - bài trình bày.mp4';
      await page.evaluate((fileName) => {
        const task = window.__bridge.tasks[0];
        Object.assign(task, { fileName, category: 'video', done: 5000 });
        window.__bridge.emit('task:status', { ...task });
      }, correctedName);
      await page.waitForFunction(() => document.querySelector('.library-count')?.textContent === '99');
      assert.equal(await categoryNav.getByRole('button', { name: /^Tài liệu/ }).locator('.filter-count').textContent(), '99');
      assert.equal(await page.getByRole('heading', { name: correctedName, exact: true }).count(), 0, 'Corrected file must leave the old category');
      const videoButton = categoryNav.getByRole('button', { name: /^Video/ });
      await videoButton.click();
      const corrected = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: correctedName, exact: true }) });
      await corrected.waitFor();
      assert.equal(await videoButton.locator('.filter-count').textContent(), '101');
      assert.equal(await page.locator('.library-count').textContent(), '101');
      assert.equal(await corrected.getByRole('progressbar', { name: /^Tiến trình/ }).getAttribute('aria-valuenow'), progressBeforeCorrection, 'Category correction must preserve progress');
      await page.screenshot({ path: path.join(output, `category-video-${width}.png`), fullPage: true });
      contrast.push({ viewport: width, state: 'category-video', failures: await textContrast(page) });
      await corrected.getByRole('button', { name: /^Hủy tải/ }).click();
      await corrected.getByText('Đã hủy', { exact: true }).waitFor();
      assert(await corrected.evaluate((element) => element === document.activeElement), 'Cancel must preserve row focus');
      assert.equal(await page.locator('.library-count').textContent(), '101', 'Canceled files must remain in their category');
      const progressBefore = await corrected.getByRole('progressbar', { name: /^Tiến trình/ }).getAttribute('aria-valuenow');
      await page.evaluate(() => window.__bridge.emit('tasks:progress', { items: [{ id: 'task-0', done: 8000, total: 8000, speed: 100, etaSec: 1, segs: Array(8).fill(100) }] }));
      assert.equal(await corrected.getByRole('progressbar', { name: /^Tiến trình/ }).getAttribute('aria-valuenow'), progressBefore);
      await page.getByRole('button', { name: /^Hoàn tất/ }).click();
      assert.equal(await page.locator('.task-row:not(.task-completed)').count(), 0);
      await page.getByRole('button', { name: /^Đang tải/ }).click();
      await page.getByRole('button', { name: 'Hủy tất cả' }).click();
      await page.getByRole('heading', { name: 'Hàng đợi đang thảnh thơi.' }).waitFor();
      assert(await page.getByRole('button', { name: 'Hủy tất cả' }).isDisabled());
      await page.goto(`${base}/?tasks=1`);
      await page.getByText('Đã kết nối', { exact: true }).waitFor();
      await page.getByRole('button', { name: /^Đang tải/ }).click();
      await page.getByRole('button', { name: /^Chi tiết tải/ }).click();
      await page.getByRole('dialog', { name: 'Chi tiết tải xuống' }).getByRole('group', { name: 'Chi tiết đoạn 8', exact: true }).waitFor();
      await page.evaluate(() => {
        const task = window.__bridge.tasks[0];
        Object.assign(task, { status: 'completed', done: 8000, speed: 0, etaSec: 0, segs: Array(8).fill(100) });
        window.__bridge.emit('task:status', { ...task });
      });
      await page.getByRole('heading', { name: 'Hàng đợi đang thảnh thơi.' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert(await page.getByRole('main').evaluate((element) => element === document.activeElement), 'Detail must restore a stable focus target when its trigger leaves the active filter');
      if (width === 1280) {
        await page.setViewportSize({ width, height: 640 });
        const otherButton = categoryNav.getByRole('button', { name: /^Khác/ });
        await otherButton.scrollIntoViewIfNeeded();
        await otherButton.click();
        const bounds = await otherButton.boundingBox();
        assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 640, 'Category controls must remain reachable on a short desktop window');
        await page.screenshot({ path: path.join(output, 'categories-short-1280.png'), fullPage: true });
      }
      results.push({ viewport: width, virtualRows: mounted, categoryVirtualRows: categoryWindows, categoryFiltersAndCounts: 'pass', sameStatusCategoryCorrection: 'pass', modalKeyboard: 'pass', segmentInputAndProgress: 'pass', taskDetail: 'pass', removedTriggerFocus: 'pass', speedAndETA: 'pass', actions: 'pass', overflow: 'none' });
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
