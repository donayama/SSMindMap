import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const browserCandidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    const fallback = path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'node',
      'node_modules',
      '.pnpm',
      'playwright@1.61.1',
      'node_modules',
      'playwright',
      'index.mjs'
    );
    return (await import(pathToFileURL(fallback).href)).chromium;
  }
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': contentType });
    res.end(data);
  });
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filePath = path.resolve(rootDir, '.' + pathname);
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    serveFile(res, filePath);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function expect(page, label, predicate, arg) {
  const ok = await page.evaluate(predicate, arg);
  if (!ok) throw new Error(`FAIL: ${label}`);
  console.log(`PASS: ${label}`);
}

async function clickCenter(page, selector) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`No box for ${selector}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function run() {
  const server = await startServer();
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/index.html`;
  const chromium = await loadChromium();
  const executablePath = browserCandidates.find(candidate => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

  page.on('console', msg => {
    if (msg.type() === 'error') console.error(`BROWSER ERROR: ${msg.text()}`);
  });
  page.on('pageerror', err => {
    throw err;
  });

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.clear();
      location.reload();
    });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('#app');
    await page.waitForSelector('.node-group[data-id="root"]');

    await expect(page, 'initial panes render', () =>
      !!document.querySelector('#tree-pane') &&
      !!document.querySelector('#sidebar') &&
      document.querySelectorAll('[data-panel-tab]').length === 4 &&
      document.querySelectorAll('.tree-item').length >= 5
    );

    await page.click('[data-panel-tab="settings"]');
    await expect(page, 'settings tab opens', () =>
      document.querySelector('#settings-panel')?.classList.contains('active') &&
      document.querySelector('#setting-confirm-delete')?.checked === true
    );

    await page.click('[data-panel-tab="node"]');
    await page.click('.tree-item[data-id="root"]');
    await expect(page, 'canvas and tree selected highlight sync', () =>
      document.querySelector('.node-group.selected')?.getAttribute('data-id') === 'root' &&
      document.querySelector('.tree-item.selected')?.getAttribute('data-id') === 'root'
    );

    const beforeTreeToggle = await page.evaluate(() => findNode('root').expanded);
    await page.click('.tree-item[data-id="root"] .tree-toggle');
    await expect(page, 'tree collapse does not collapse canvas nodes', () =>
      findNode('root').expanded === true &&
      document.querySelectorAll('.tree-item').length === 1 &&
      document.querySelectorAll('.node-group').length >= 5
    );
    if (!beforeTreeToggle) throw new Error('unexpected root expanded state');
    await page.click('.tree-item[data-id="root"] .tree-toggle');

    await page.keyboard.press('Tab');
    await page.waitForSelector('#inline-edit-input[style*="display: block"]');
    await page.fill('#inline-edit-input', 'E2E Child');
    await page.keyboard.press('Enter');
    await expect(page, 'keyboard adds child node and selects it', () =>
      !![...document.querySelectorAll('.tree-item')].find(el => el.textContent.includes('E2E Child')) &&
      findNode(selectedId)?.text === 'E2E Child'
    );
    const e2eChildId = await page.evaluate(() => selectedId);

    await page.click('[data-panel-tab="node"]');
    await page.selectOption('#node-shape-select', 'hexagon');
    await page.selectOption('#node-border-style-select', 'dashdot');
    await page.locator('#node-panel input[type="range"]').fill('4');
    await expect(page, 'shape and border settings apply', id => {
      const n = findNode(id);
      return n?.shape === 'hexagon' && n?.borderStyle === 'dashdot' && Number(n?.borderWidth) === 4;
    }, e2eChildId);

    await page.click(`.tree-item[data-id="${e2eChildId}"]`);
    await page.keyboard.press('Delete');
    await page.waitForSelector('#modal-overlay.open');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page, 'modal blocks global hotkeys', id =>
      document.querySelector('#modal-overlay')?.classList.contains('open') &&
      !!findNode(id) &&
      document.querySelectorAll('.node-group').length < 20
    , e2eChildId);
    await page.keyboard.press('Escape');
    await expect(page, 'escape closes modal without deleting', id =>
      !document.querySelector('#modal-overlay')?.classList.contains('open') && !!findNode(id)
    , e2eChildId);

    await page.click('[data-panel-tab="settings"]');
    await page.uncheck('#setting-confirm-delete');
    await expect(page, 'delete confirmation setting persists in memory', () =>
      appSettings.confirmDelete === false &&
      localStorage.getItem('ss-mindmap-settings')?.includes('"confirmDelete":false')
    );

    await page.click(`.tree-item[data-id="${e2eChildId}"]`);
    await page.keyboard.press('Delete');
    await expect(page, 'delete without confirmation removes node immediately', id =>
      !document.querySelector('#modal-overlay')?.classList.contains('open') && !findNode(id)
    , e2eChildId);

    await page.click('.tree-item[data-id="root"]');
    await page.keyboard.press('Tab');
    await page.waitForSelector('#inline-edit-input[style*="display: block"]');
    await page.fill('#inline-edit-input', '[[Linked Map]]');
    await page.keyboard.press('Enter');
    const linkNodeId = await page.evaluate(() => selectedId);
    await page.fill('#map-title-input', 'Source Map');
    await page.evaluate(() => persistCurrentMap());
    await page.evaluate(() => createNewMap(false));
    await page.fill('#map-title-input', 'Linked Map');
    await page.evaluate(() => persistCurrentMap());
    await page.selectOption('#map-switcher', { label: 'Source Map' });
    await page.waitForFunction(() => document.querySelector('#map-title-input')?.value === 'Source Map');
    await expect(page, 'map switcher changes maps', () =>
      document.querySelector('#map-title-input')?.value === 'Source Map'
    );
    await clickCenter(page, `.node-group[data-id="${linkNodeId}"] text tspan`);
    await page.waitForFunction(() => document.querySelector('#map-title-input')?.value === 'Linked Map');
    await expect(page, 'internal map link switches to linked map', () =>
      document.querySelector('#map-title-input')?.value === 'Linked Map'
    );

    await page.evaluate(() => {
      appSettings.confirmDelete = true;
      saveSettings();
      syncSettingsUI();
    });
    await expect(page, 'settings can be restored to safe default', () =>
      appSettings.confirmDelete === true &&
      JSON.parse(localStorage.getItem('ss-mindmap-settings')).confirmDelete === true
    );

    const errors = await page.evaluate(() => window.__e2eErrors || []);
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
