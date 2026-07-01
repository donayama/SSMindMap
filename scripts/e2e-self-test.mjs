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

async function dragCenterToCenter(page, fromSelector, toSelector, modifiers = []) {
  const from = await page.locator(fromSelector).boundingBox();
  const to = await page.locator(toSelector).boundingBox();
  if (!from || !to) throw new Error(`Cannot drag ${fromSelector} to ${toSelector}`);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  for (const key of modifiers.reverse()) await page.keyboard.up(key);
}

async function run() {
  const server = await startServer();
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/index.html`;
  const tempImportPath = path.join(rootDir, '.tmp-e2e-import.json');
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
    await page.selectOption('#setting-tree-position', 'right');
    await page.selectOption('#setting-sidebar-position', 'left');
    await expect(page, 'pane positions can be changed from settings', () =>
      document.body.classList.contains('tree-right') &&
      document.body.classList.contains('sidebar-left') &&
      JSON.parse(localStorage.getItem('ss-mindmap-settings')).treePosition === 'right' &&
      JSON.parse(localStorage.getItem('ss-mindmap-settings')).sidebarPosition === 'left'
    );
    await page.selectOption('#setting-tree-position', 'left');
    await page.selectOption('#setting-sidebar-position', 'right');

    await page.click('[data-panel-tab="node"]');
    await page.click('.tree-item[data-id="root"]');
    await expect(page, 'move guide explains root cannot move', () =>
      document.querySelector('#move-guide')?.textContent.includes('ルートノードは移動できません')
    );
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

    await expect(page, 'move guide explains child move options', () =>
      document.querySelector('#move-guide')?.textContent.includes('Ctrl') &&
      document.querySelector('#move-guide')?.textContent.includes('別の親へ移動')
    );

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

    await page.click('.tree-item[data-id="n1"]');
    await dragCenterToCenter(page, '.node-group[data-id="n2"]', '.node-group[data-id="n1"]', ['Control']);
    await expect(page, 'ctrl drag moves a node under a new parent', () =>
      findParent('n2')?.id === 'n1'
    );

    await page.click('#btn-relation-mode');
    await clickCenter(page, '.node-group[data-id="root"]');
    await clickCenter(page, '.node-group[data-id="n1"]');
    await expect(page, 'relation mode creates relation line', () =>
      Array.isArray(mindmap.relations) &&
      mindmap.relations.some(r => r.fromId === 'root' && r.toId === 'n1') &&
      document.querySelectorAll('.relation-line').length > 0
    );

    await page.click('.tree-item[data-id="n1"]');
    await page.fill('#search-input', 'アイデア');
    await expect(page, 'search finds tree and canvas matches', () =>
      document.querySelector('#search-status')?.textContent.includes('件') &&
      document.querySelectorAll('.node-search-match').length >= 1
    );
    await page.click('#search-next');
    await expect(page, 'search navigation selects a result', () =>
      !!selectedId && findNode(selectedId)?.text.includes('アイデア')
    );
    await page.fill('#search-input', '');
    await page.click('.tree-item[data-id="n1"]');

    await page.click('[data-panel-tab="ai"]');
    await page.fill('#ai-response-text', '{"ideas":["AI Idea One","AI Idea Two"]}');
    await page.click('button[onclick="parseAiResponse()"]');
    await page.click('button[onclick="addAllIdeas()"]');
    await expect(page, 'AI parsed ideas can be added to selected node', () =>
      !!findNode('n1')?.children?.some(c => c.text === 'AI Idea One') &&
      !!findNode('n1')?.children?.some(c => c.text === 'AI Idea Two')
    );

    await page.click('.tree-item[data-id="n1"]');
    await page.click('[data-panel-tab="node"]');
    await page.fill('#node-memo-input', 'E2E memo bubble');
    await expect(page, 'memo bubble renders on canvas', () =>
      !!findNode('n1')?.memo &&
      document.querySelectorAll('.memo-bubble').length > 0
    );

    await page.click('#btn-undo');
    await expect(page, 'undo reverts last memo edit', () =>
      !findNode('n1')?.memo
    );
    await page.click('#btn-redo');
    await expect(page, 'redo restores memo edit', () =>
      findNode('n1')?.memo === 'E2E memo bubble'
    );

    const relationId = await page.evaluate(() => mindmap.relations[0]?.id);
    await page.evaluate(id => selectRelation(id), relationId);
    await page.fill('#node-panel-content input[type="text"]', 'E2E relation');
    await page.locator('#node-panel-content input[type="range"]').fill('5');
    await page.evaluate(() => setRelProp('dash', '10 4 2 4'));
    await expect(page, 'relation properties can be edited', id => {
      const rel = mindmap.relations.find(r => r.id === id);
      return rel?.label === 'E2E relation' &&
        Number(rel?.strokeWidth) === 5 &&
        rel?.dash === '10 4 2 4';
    }, relationId);
    await page.evaluate(id => confirmDeleteRelation(id), relationId);
    await expect(page, 'relation delete obeys no-confirm setting', id =>
      !mindmap.relations.some(r => r.id === id) &&
      !document.querySelector('#modal-overlay')?.classList.contains('open')
    , relationId);

    await page.click('.tree-item[data-id="n1"]');
    await page.click('#hdr-copy');
    await expect(page, 'copy button duplicates selected node', () =>
      mindmap.root.children.filter(c => c.text === 'アイデア A').length >= 2
    );
    await page.click('#hdr-cut');
    await page.click('.tree-item[data-id="root"]');
    await page.click('#hdr-paste');
    await expect(page, 'cut and paste path remains usable', () =>
      !cutBuffer && findParent(selectedId)?.id === 'root'
    );

    await page.fill('#map-title-input', 'Download Smoke');
    const jsonDownload = page.waitForEvent('download');
    await page.evaluate(() => saveJSON());
    const json = await jsonDownload;
    if (!json.suggestedFilename().endsWith('.json')) throw new Error('JSON download did not use .json');
    const jsonPath = await json.path();
    const jsonText = fs.readFileSync(jsonPath, 'utf8');
    if (!JSON.parse(jsonText).root) throw new Error('JSON download content is invalid');
    console.log('PASS: JSON download content is valid');

    const mdDownload = page.waitForEvent('download');
    await page.evaluate(() => saveMarkdown());
    const md = await mdDownload;
    if (!md.suggestedFilename().endsWith('.md')) throw new Error('Markdown download did not use .md');
    const mdPath = await md.path();
    const mdText = fs.readFileSync(mdPath, 'utf8');
    if (!mdText.includes('# ')) throw new Error('Markdown download content is invalid');
    console.log('PASS: Markdown download content is valid');

    const pngDownload = page.waitForEvent('download');
    await page.evaluate(() => exportPNG());
    const png = await pngDownload;
    if (!png.suggestedFilename().endsWith('.png')) throw new Error('PNG download did not use .png');
    const pngPath = await png.path();
    const pngHeader = fs.readFileSync(pngPath).subarray(0, 8).toString('hex');
    if (pngHeader !== '89504e470d0a1a0a') throw new Error('PNG download content is invalid');
    console.log('PASS: PNG download content is valid');

    const yamlAvailable = await page.waitForFunction(() => typeof window.jsyaml !== 'undefined', null, { timeout: 5000 }).then(() => true).catch(() => false);
    if (yamlAvailable) {
      const yamlDownload = page.waitForEvent('download');
      await page.evaluate(() => saveYAML());
      const yaml = await yamlDownload;
      if (!yaml.suggestedFilename().endsWith('.yaml')) throw new Error('YAML download did not use .yaml');
      const yamlPath = await yaml.path();
      if (!fs.readFileSync(yamlPath, 'utf8').includes('root:')) throw new Error('YAML download content is invalid');
      console.log('PASS: YAML download content is valid');
    } else {
      console.log('SKIP: YAML download content test (js-yaml CDN unavailable)');
    }

    const pdfAvailable = await page.waitForFunction(() => typeof window.jspdf !== 'undefined', null, { timeout: 5000 }).then(() => true).catch(() => false);
    if (pdfAvailable) {
      const pdfDownload = page.waitForEvent('download');
      await page.evaluate(() => exportPDF());
      const pdf = await pdfDownload;
      if (!pdf.suggestedFilename().endsWith('.pdf')) throw new Error('PDF download did not use .pdf');
      const pdfPath = await pdf.path();
      if (!fs.readFileSync(pdfPath, 'utf8').startsWith('%PDF')) throw new Error('PDF download content is invalid');
      console.log('PASS: PDF download content is valid');
    } else {
      console.log('SKIP: PDF download content test (jsPDF CDN unavailable)');
    }

    const importMap = {
      title: 'Imported E2E Map',
      root: { id: 'root', text: 'Imported Root', x: 0, y: 0, expanded: true, children: [
        { id: 'imp1', text: 'Imported Child', x: 0, y: 0, expanded: true, children: [] }
      ] },
      relations: []
    };
    fs.writeFileSync(tempImportPath, JSON.stringify(importMap, null, 2));
    await page.setInputFiles('#file-input', tempImportPath);
    await page.waitForFunction(() => document.querySelector('#map-title-input')?.value === 'Imported E2E Map');
    await expect(page, 'JSON file import loads a map', () =>
      mindmap.title === 'Imported E2E Map' &&
      mindmap.root.text === 'Imported Root' &&
      !!findNode('imp1')
    );

    await page.click('.tree-item[data-id="root"]');
    await page.keyboard.press('Tab');
    await page.waitForSelector('#inline-edit-input[style*="display: block"]');
    await page.fill('#inline-edit-input', '[[Linked Map]]');
    await page.keyboard.press('Enter');
    const linkNodeId = await page.evaluate(() => selectedId);
    await page.fill('#map-title-input', 'Source Map');
    await page.evaluate(() => persistCurrentMap());
    await page.evaluate(() => createNewMap(false));
    await expect(page, 'map count is visible after creating another map', () =>
      Number((document.querySelector('#map-count')?.textContent || '').replace(/\D/g, '')) >= 2
    );
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

    await page.setViewportSize({ width: 390, height: 780 });
    await expect(page, 'narrow viewport keeps primary UI usable', () => {
      const canvas = document.querySelector('#canvas-container')?.getBoundingClientRect();
      const header = document.querySelector('#header')?.getBoundingClientRect();
      return canvas && header &&
        canvas.width > 100 &&
        canvas.height > 300 &&
        header.height > 0 &&
        !!document.querySelector('#map-switcher') &&
        !!document.querySelector('#move-guide');
    });

    const errors = await page.evaluate(() => window.__e2eErrors || []);
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    if (fs.existsSync(tempImportPath)) fs.unlinkSync(tempImportPath);
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
