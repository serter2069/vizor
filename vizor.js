#!/usr/bin/env node

// Resolve playwright from isolated ~/.vizor runtime, global npm, or local project
let playwright;
const os = require('os');
const path = require('path');
const fsSync = require('fs');
const { execSync } = require('child_process');

const vizorHome = path.join(os.homedir(), '.vizor');
const vizorPlaywright = path.join(vizorHome, 'node_modules/playwright');

// Self-bootstrap: if isolated runtime missing, install it once
if (!fsSync.existsSync(vizorPlaywright)) {
  console.error('[vizor] First-run setup: installing playwright + chromium into ~/.vizor (~165MB download)...');
  try {
    fsSync.mkdirSync(vizorHome, { recursive: true });
    const pkgPath = path.join(vizorHome, 'package.json');
    if (!fsSync.existsSync(pkgPath)) {
      fsSync.writeFileSync(pkgPath, JSON.stringify({ name: 'vizor-runtime', version: '1.0.0', private: true }, null, 2));
    }
    execSync('npm install playwright', { cwd: vizorHome, stdio: 'inherit' });
    execSync('npx playwright install chromium', { cwd: vizorHome, stdio: 'inherit' });
    console.error('[vizor] Setup complete.');
  } catch (err) {
    console.error(`[vizor] Bootstrap failed: ${err.message}`);
    console.error('[vizor] Manual fix: cd ~/.vizor && npm install playwright && npx playwright install chromium');
    process.exit(1);
  }
}

const globalRoot = execSync('npm root -g').toString().trim();
const tryPaths = [
  vizorPlaywright,
  'playwright',
  path.join(globalRoot, '@playwright/cli/node_modules/playwright'),
  path.join(globalRoot, '@playwright/test/node_modules/playwright'),
  path.join(globalRoot, '@playwright/mcp/node_modules/playwright'),
];
for (const p of tryPaths) {
  try { playwright = require(p); break; } catch (_) {}
}
if (!playwright) {
  console.error('Error: playwright not found. Manual fix: cd ~/.vizor && npm install playwright && npx playwright install chromium');
  process.exit(1);
}
const { chromium } = playwright;
const fs = require('fs');

const {
  extractLayout,
  flatten,
  formatTree,
  generateOutput,
  collectProblems,
  detectZConflicts,
  formatProblems,
  diffOutput,
  describeTree,
  collectComputedExtras,
  extractTreeFromPage,
  snapshotElementStyle,
  formatHoverDiff,
  extractAriaFromDom,
  formatAriaTree,
  captureViewport,
  formatSweep,
  takeScreenshot,
  runActions,
  formatActionLog,
  parseFlowFile,
  formatNetCapture,
} = require('./lib.js');

const args = process.argv.slice(2);

function parseArgs(args) {
  const opts = {
    url: null,
    viewport: { width: 430, height: 932 },
    depth: 8,
    warnings: true,
    wait: 2000,
    cdp: null,
    save: null,
    diff: null,
    problems: false,
    compare: false,
    describe: false,
    hover: null,
    sweep: false,
    sweepViewports: null,
    aria: false,
    actions: [],
    actionsLog: false,
    headed: false,
    slowMo: 0,
    net: { capture: false, stubs: [], blocks: [] },
    screenshotQuality: null,
    screenshotWidth: null,
    captureConsole: null,
    vizorHome: path.join(os.homedir(), '.vizor'),
    recordVideo: null,
    videoFps: 2,
    videoQuality: 40,
    videoTmpDir: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--viewport' && args[i + 1]) {
      const [w, h] = args[++i].split('x').map(Number);
      if (w && h) opts.viewport = { width: w, height: h };
    } else if (a === '--depth' && args[i + 1]) {
      opts.depth = parseInt(args[++i], 10);
    } else if (a === '--desktop') {
      opts.viewport = { width: 1440, height: 900 };
    } else if (a === '--no-warnings') {
      opts.warnings = false;
    } else if (a === '--wait' && args[i + 1]) {
      // Ambiguous: if next arg is an integer, treat as initial render wait.
      // Otherwise it's a selector for wait-for (interactive). Integers-only here.
      const next = args[i + 1];
      if (/^\d+$/.test(next)) {
        opts.wait = parseInt(args[++i], 10);
      } else {
        opts.actions.push({ type: 'wait-for', selector: args[++i] });
      }
    } else if (a === '--wait-for' && args[i + 1]) {
      opts.actions.push({ type: 'wait-for', selector: args[++i] });
    } else if (a === '--wait-gone' && args[i + 1]) {
      opts.actions.push({ type: 'wait-gone', selector: args[++i] });
    } else if (a === '--wait-ms' && args[i + 1]) {
      opts.actions.push({ type: 'wait', ms: parseInt(args[++i], 10) });
    } else if (a === '--click' && args[i + 1]) {
      opts.actions.push({ type: 'click', selector: args[++i] });
    } else if (a === '--fill' && args[i + 2]) {
      opts.actions.push({ type: 'fill', selector: args[++i], value: args[++i] });
    } else if (a === '--type' && args[i + 2]) {
      opts.actions.push({ type: 'type', selector: args[++i], value: args[++i] });
    } else if (a === '--press' && args[i + 1]) {
      opts.actions.push({ type: 'press', key: args[++i] });
    } else if (a === '--goto' && args[i + 1]) {
      opts.actions.push({ type: 'goto', url: args[++i] });
    } else if (a === '--screenshot' && args[i + 1]) {
      opts.actions.push({ type: 'screenshot', file: args[++i] });
    } else if ((a === '--full-screenshot' || a === '--fullpage') && args[i + 1]) {
      opts.actions.push({ type: 'screenshot', file: args[++i], full: true });
    } else if (a === '--screenshot-quality' && args[i + 1]) {
      opts.screenshotQuality = parseInt(args[++i], 10);
    } else if (a === '--screenshot-width' && args[i + 1]) {
      opts.screenshotWidth = parseInt(args[++i], 10);
    } else if ((a === '--screenshot-webp' || a === '--ss') && args[i + 1]) {
      // shortcut: --ss FILE → WebP at quality 55, 1200px max, full page
      opts.actions.push({ type: 'screenshot', file: args[++i].replace(/(\.\w+)?$/, '.webp'), full: true });
      if (!opts.screenshotQuality) opts.screenshotQuality = 55;
      if (!opts.screenshotWidth) opts.screenshotWidth = 1200;
    } else if (a === '--get' && args[i + 1]) {
      opts.actions.push({ type: 'get', selector: args[++i] });
    } else if (a === '--get-attr' && args[i + 2]) {
      opts.actions.push({ type: 'get-attr', selector: args[++i], name: args[++i] });
    } else if (a === '--assert-visible' && args[i + 1]) {
      opts.actions.push({ type: 'assert-visible', selector: args[++i] });
    } else if (a === '--assert-enabled' && args[i + 1]) {
      opts.actions.push({ type: 'assert-enabled', selector: args[++i] });
    } else if (a === '--assert-checked' && args[i + 1]) {
      opts.actions.push({ type: 'assert-checked', selector: args[++i] });
    } else if (a === '--scroll' && args[i + 1]) {
      const dir = args[++i];
      const px = args[i + 1] && /^\d+$/.test(args[i + 1]) ? parseInt(args[++i], 10) : 0;
      opts.actions.push({ type: 'scroll', direction: dir, px });
    } else if (a === '--select' && args[i + 2]) {
      opts.actions.push({ type: 'select', selector: args[++i], value: args[++i] });
    } else if (a === '--console-errors') {
      opts.captureConsole = 'errors';
    } else if (a === '--console-logs') {
      opts.captureConsole = 'all';
    } else if (a === '--cookies-load' && args[i + 1]) {
      opts.actions.unshift({ type: 'cookies-load', file: args[++i] });
    } else if (a === '--cookies-save' && args[i + 1]) {
      opts.actions.push({ type: 'cookies-save', file: args[++i] });
    } else if (a === '--drag' && args[i + 2]) {
      opts.actions.push({ type: 'drag', source: args[++i], target: args[++i] });
    } else if (a === '--upload' && args[i + 2]) {
      const sel = args[++i];
      const files = [];
      while (args[i + 1] && !args[i + 1].startsWith('--')) files.push(args[++i]);
      opts.actions.push({ type: 'upload', selector: sel, files });
    } else if (a === '--screenshot-diff' && args[i + 1]) {
      const step = { type: 'screenshot-diff', baseline: args[++i] };
      if (args[i + 1] && !args[i + 1].startsWith('--')) step.maxDiff = parseFloat(args[++i]);
      opts.actions.push(step);
    } else if (a === '--screenshot-diff-save' && args[i + 1]) {
      const last = opts.actions.findLast(s => s.type === 'screenshot-diff');
      if (last) last.saveDiff = args[++i];
    } else if (a === '--assert-exists' && args[i + 1]) {
      opts.actions.push({ type: 'assert-exists', selector: args[++i] });
    } else if (a === '--assert-text' && args[i + 2]) {
      opts.actions.push({ type: 'assert-text', selector: args[++i], value: args[++i] });
    } else if (a === '--assert-url' && args[i + 1]) {
      opts.actions.push({ type: 'assert-url', value: args[++i] });
    } else if (a === '--flow' && args[i + 1]) {
      const steps = parseFlowFile(args[++i]);
      opts.actions.push(...steps);
    } else if (a === '--new-tab' && args[i + 1]) {
      opts.actions.push({ type: 'new-tab', url: args[++i] });
    } else if (a === '--new-tab-blank') {
      opts.actions.push({ type: 'new-tab', url: '' });
    } else if (a === '--switch-tab' && args[i + 1]) {
      opts.actions.push({ type: 'switch-tab', index: parseInt(args[++i], 10) });
    } else if (a === '--close-tab') {
      opts.actions.push({ type: 'close-tab' });
    } else if (a === '--net-capture') {
      opts.net.capture = true;
    } else if (a === '--net-stub' && args[i + 2]) {
      opts.net.stubs.push({ pattern: args[++i], file: args[++i] });
    } else if (a === '--net-block' && args[i + 1]) {
      opts.net.blocks.push(args[++i]);
    } else if (a === '--actions-log') {
      opts.actionsLog = true;
    } else if (a === '--headed') {
      opts.headed = true;
    } else if (a === '--slow-mo' && args[i + 1]) {
      opts.slowMo = parseInt(args[++i], 10);
    } else if (a === '--cdp' && args[i + 1]) {
      opts.cdp = parseInt(args[++i], 10);
    } else if (a === '--save' && args[i + 1]) {
      opts.save = args[++i];
    } else if (a === '--diff' && args[i + 1]) {
      opts.diff = args[++i];
    } else if (a === '--problems') {
      opts.problems = true;
    } else if (a === '--compare') {
      opts.compare = true;
    } else if (a === '--describe') {
      opts.describe = true;
    } else if (a === '--hover' && args[i + 1]) {
      opts.hover = args[++i];
    } else if (a === '--sweep') {
      opts.sweep = true;
    } else if (a === '--sweep-viewports' && args[i + 1]) {
      opts.sweep = true;
      opts.sweepViewports = args[++i].split(',').map(s => {
        const [w, h] = s.trim().split('x').map(Number);
        return { width: w, height: h };
      }).filter(v => v.width && v.height);
    } else if (a === '--record-video' && args[i + 1]) {
      opts.recordVideo = args[++i];
    } else if (a === '--video-fps' && args[i + 1]) {
      opts.videoFps = parseInt(args[++i], 10);
    } else if (a === '--video-quality' && args[i + 1]) {
      opts.videoQuality = parseInt(args[++i], 10);
    } else if (a === '--aria') {
      opts.aria = true;
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: vizor <url> [options]

Analysis modes (pick one; default is tree output):
  --describe        synthesize design summary (palette, typography, layout)
  --problems        show ONLY detected problems, skip full tree
  --aria            emit ARIA tree
  --hover SEL       capture :hover style delta for SEL
  --compare         compare mobile (430x932) vs desktop (1440x900)
  --sweep           analyze across 5 viewports: 320/430/768/1024/1440px
  --sweep-viewports W1xH1,W2xH2,...  sweep with custom viewport list
  --diff FILE       compare current tree with saved baseline

Interactive actions (applied in order, before analysis mode):
  --click SEL               click element
  --fill SEL VAL            clear + fill input
  --type SEL VAL            type into input (no clear)
  --press KEY               press keyboard key (Enter, Tab, ArrowDown, …)
  --goto URL                navigate mid-flow
  --wait-for SEL            wait until SEL visible (10s max)
  --wait-gone SEL           wait until SEL is hidden/removed (10s max)
  --wait-ms N               sleep N milliseconds
  --assert-exists SEL       fail run if SEL missing
  --assert-text SEL TEXT    fail if element text lacks TEXT
  --assert-url TEXT         fail if current URL lacks TEXT
  --flow FILE               load actions from JSON array or line-based file
  --actions-log             always print the action log (default: only on failure)
  --new-tab URL             open URL in new tab (switches active tab)
  --new-tab-blank           open blank tab
  --switch-tab N            switch active tab by index (0 = first)
  --close-tab               close active tab, switch to previous

Screenshot:
  --screenshot FILE         save screenshot (PNG/JPEG/WebP by extension)
  --screenshot-quality N    JPEG/WebP quality 1-100 (default: 70 JPEG, 55 WebP)
  --screenshot-width N      resize to max N px wide (requires sharp, auto-installed)
  --ss FILE                 shortcut: WebP, quality 55, max 1200px

Video recording:
  --record-video FILE       record session to FILE (.mp4 via ffmpeg, .webm fallback)
  --video-fps N             frames per second (default: 2)
  --video-quality N         ffmpeg CRF quality 1-51 (default: 40, lower=better)

State assertions:
  --assert-visible SEL      fail if element not visible
  --assert-enabled SEL      fail if element not enabled
  --assert-checked SEL      fail if checkbox not checked

Queries (output in action log):
  --get SEL                 print text content of element
  --get-attr SEL NAME       print attribute value

Interaction:
  --scroll up|down|top|bottom|SEL [px]  scroll page or element into view
  --select SEL VALUE        select dropdown option
  --drag SOURCE TARGET      drag element SOURCE and drop onto TARGET
  --upload SEL FILE...      set files on <input type="file"> element

Visual regression:
  --screenshot-diff BASELINE [maxDiff%]  compare vs baseline PNG (auto-saves if missing)
  --screenshot-diff-save FILE            save current screenshot alongside diff check

Console:
  --console-errors          capture JS errors + uncaught exceptions
  --console-logs            capture all console output

Session:
  --cookies-load FILE       load cookies from JSON before navigation
  --cookies-save FILE       save cookies to JSON after flow

Network:
  --net-capture             capture all XHR/fetch, print summary after analysis
  --net-stub PATTERN FILE   stub matching requests with JSON from FILE
  --net-block PATTERN       abort requests matching PATTERN

Setup:
  --viewport WxH    viewport size (default: 430x932)
  --depth N         max tree depth (default: 8, describe auto-uses ≥12)
  --desktop         shortcut for --viewport 1440x900
  --no-warnings     hide warning flags
  --wait N          ms initial render wait (default: 2000)
  --cdp PORT        connect via CDP instead of launching headless
  --save FILE       save analysis output to file`);
      process.exit(0);
    } else if (!a.startsWith('--') && !opts.url) {
      opts.url = a;
    }
  }

  if (!opts.url) {
    console.error('Error: URL required. Usage: vizor <url> [options]');
    process.exit(1);
  }

  return opts;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return (u.pathname + (u.search || '')).slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

// true if any of the analysis modes is selected
function hasAnalysisMode(opts) {
  return !!(opts.problems || opts.compare || opts.describe || opts.hover || opts.sweep || opts.aria || opts.diff);
}

async function saveVideoFile(page, opts) {
  if (!opts.recordVideo || !page) return;
  const video = page.video && page.video();
  if (!video) return;

  const outFile = opts.recordVideo;
  const needsFfmpeg = outFile.endsWith('.mp4');
  const rawWebm = needsFfmpeg
    ? path.join(opts.videoTmpDir || os.tmpdir(), `vizor-raw-${Date.now()}.webm`)
    : outFile;

  try {
    await video.saveAs(rawWebm);
  } catch (e) {
    console.error(`[vizor] Video save failed: ${e.message}`);
    return;
  }

  if (needsFfmpeg) {
    try {
      execSync('which ffmpeg 2>/dev/null || where ffmpeg 2>/dev/null', { stdio: 'ignore' });
      execSync(
        `ffmpeg -y -i "${rawWebm}" -vf "mpdecimate" -vsync vfr -c:v libx264 -crf ${opts.videoQuality} -preset fast "${outFile}" 2>/dev/null`,
        { stdio: 'pipe' }
      );
      fs.unlinkSync(rawWebm);
      console.error(`[vizor] Video: ${outFile} (${Math.round(fs.statSync(outFile).size / 1024)}KB)`);
    } catch {
      const webmOut = outFile.replace(/\.mp4$/, '.webm');
      try { fs.renameSync(rawWebm, webmOut); } catch {}
      console.error(`[vizor] ffmpeg not found — saved as WebM: ${webmOut}`);
    }
  } else {
    console.error(`[vizor] Video: ${outFile} (${Math.round(fs.statSync(outFile).size / 1024)}KB)`);
  }

  if (opts.videoTmpDir) {
    try { fs.rmSync(opts.videoTmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function run() {
  const opts = parseArgs(args);
  let browser, context, page;

  try {
    if (opts.sweep) {
      // --sweep: analyze across multiple viewports
      const viewports = opts.sweepViewports || [
        { width: 320, height: 640 },
        { width: 430, height: 932 },
        { width: 768, height: 1024 },
        { width: 1024, height: 768 },
        { width: 1440, height: 900 },
      ];
      browser = await chromium.launch({ headless: !opts.headed, slowMo: opts.slowMo || 0 });
      const results = [];
      for (const vp of viewports) {
        try {
          const r = await captureViewport(browser, opts, vp);
          results.push(r);
        } catch (err) {
          results.push({ vp, error: err.message });
        }
      }
      const output = formatSweep(results, opts.url);
      console.log(output);
      if (opts.save) {
        fs.writeFileSync(opts.save, output, 'utf-8');
        console.log(`\nSaved to ${opts.save}`);
      }
    } else if (opts.compare) {
      // Feature 3: --compare — two viewports
      const viewports = [
        { width: 430, height: 932, label: 'MOBILE' },
        { width: 1440, height: 900, label: 'DESKTOP' },
      ];

      if (opts.cdp) {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.cdp}`);
      } else {
        browser = await chromium.launch({ headless: !opts.headed, slowMo: opts.slowMo || 0 });
      }

      const outputs = [];
      for (const vp of viewports) {
        let ctx, pg;
        if (opts.cdp) {
          const contexts = browser.contexts();
          ctx = contexts[0] || await browser.newContext({ viewport: vp });
          pg = await ctx.newPage();
          await pg.setViewportSize(vp);
        } else {
          ctx = await browser.newContext({ viewport: vp });
          pg = await ctx.newPage();
        }

        await pg.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await pg.waitForTimeout(opts.wait);
        const tree = await pg.evaluate(extractLayout, opts.depth);

        if (!tree) {
          outputs.push(`=== ${vp.label} (${vp.width}×${vp.height}) ===\nError: Could not extract layout`);
        } else {
          const flatTree = flatten(tree);
          const lines = [];
          lines.push(`=== ${vp.label} (${vp.width}×${vp.height}) ===`);
          formatTree(flatTree, '', lines, opts.warnings);
          outputs.push(lines.join('\n'));
        }

        if (!opts.cdp) await ctx.close();
        else await pg.close();
      }

      const fullOutput = outputs.join('\n\n');
      console.log(fullOutput);

      if (opts.save) {
        fs.writeFileSync(opts.save, fullOutput, 'utf-8');
        console.log(`\nSaved to ${opts.save}`);
      }

    } else {
      // Normal / --problems / --diff mode
      if (opts.cdp) {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.cdp}`);
        const contexts = browser.contexts();
        context = contexts[0] || await browser.newContext({ viewport: opts.viewport });
        page = context.pages()[0] || await context.newPage();
        await page.setViewportSize(opts.viewport);
      } else {
        browser = await chromium.launch({ headless: !opts.headed, slowMo: opts.slowMo || 0 });
        const contextOpts = { viewport: opts.viewport };
        if (opts.recordVideo) {
          opts.videoTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vizor-video-'));
          contextOpts.recordVideo = { dir: opts.videoTmpDir, size: opts.viewport };
        }
        context = await browser.newContext(contextOpts);
        page = await context.newPage();
      }

      // Describe mode benefits from deeper traversal (nav items, hero text often nested)
      if (opts.describe && opts.depth < 12) opts.depth = 12;

      // Network interception — set up before first navigation
      const netLog = [];
      if (opts.net.stubs.length > 0) {
        for (const stub of opts.net.stubs) {
          const body = fs.readFileSync(stub.file, 'utf-8');
          await page.route(stub.pattern, route => {
            route.fulfill({ status: 200, contentType: 'application/json', body });
          });
        }
      }
      if (opts.net.blocks.length > 0) {
        for (const pat of opts.net.blocks) {
          await page.route(pat, route => route.abort());
        }
      }
      if (opts.net.capture) {
        const pending = new Map();
        const SKIP_TYPES = new Set(['document', 'stylesheet', 'image', 'font', 'media', 'websocket', 'other']);
        page.on('request', req => {
          if (SKIP_TYPES.has(req.resourceType())) return;
          pending.set(req.url(), { method: req.method(), t0: Date.now(), url: req.url(), shortUrl: shortUrl(req.url()), blocked: false });
        });
        page.on('response', async res => {
          const entry = pending.get(res.url());
          if (!entry) return;
          entry.status = res.status();
          entry.ms = Date.now() - entry.t0;
          try { const buf = await res.body(); entry.size = buf.length; } catch { entry.size = 0; }
          netLog.push({ ...entry });
          pending.delete(res.url());
        });
        page.on('requestfailed', req => {
          const entry = pending.get(req.url());
          if (!entry) return;
          entry.blocked = true;
          entry.ms = Date.now() - entry.t0;
          entry.size = 0;
          netLog.push({ ...entry });
          pending.delete(req.url());
        });
      }

      // Initial goto + render wait (extractTreeFromPage does its own goto too — but we need the page
      // loaded before actions run. If actions include an early --goto they'll override cleanly.)
      if (opts.actions.length > 0) {
        await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        try { await page.waitForLoadState('networkidle', { timeout: 4000 }); } catch {}
        await page.waitForTimeout(opts.wait);
        const result = await runActions(context, page, opts.actions, {
          captureConsole: opts.captureConsole,
          screenshotQuality: opts.screenshotQuality,
          screenshotWidth: opts.screenshotWidth,
          vizorHome: opts.vizorHome,
        });
        if (!result.ok || opts.actionsLog) {
          console.error(formatActionLog(result));
        }
        if (result.consoleLogs && result.consoleLogs.length > 0) {
          const lines = ['\nCONSOLE:'];
          for (const l of result.consoleLogs) {
            lines.push(`  [${l.type}] ${l.text}`);
          }
          console.error(lines.join('\n'));
        }
        if (!result.ok) {
          process.exit(2);
        }
        page = result.page || page;
        // If no analysis mode requested and no failure, print the success log and exit.
        if (!hasAnalysisMode(opts) && !opts.net.capture) {
          if (!opts.actionsLog) console.log(formatActionLog(result));
          return;
        }
        if (!hasAnalysisMode(opts)) {
          if (!opts.actionsLog) console.log(formatActionLog(result));
          // fall through to print net capture
          if (opts.net.capture) {
            await page.waitForTimeout(300);
            console.log('\n' + formatNetCapture(netLog, opts.url));
          }
          return;
        }
        // Analysis mode: extract tree from CURRENT state (no re-goto).
        var tree = await page.evaluate(extractLayout, opts.depth);
      } else {
        var tree = await extractTreeFromPage(page, opts);
      }

      if (!tree) {
        console.error('Error: Could not extract layout (body not found or invisible)');
        process.exit(1);
      }

      if (opts.aria) {
        // --aria: ARIA tree (DOM-derived — robust across Playwright versions)
        const snap = await page.evaluate(extractAriaFromDom);
        const output = snap && snap.children && snap.children.length
          ? `ARIA TREE: ${opts.url}\n${'─'.repeat(40)}\n${formatAriaTree(snap, '')}`
          : `ARIA TREE: (empty — no ARIA-relevant elements found)`;
        console.log(output);
        if (opts.save) {
          fs.writeFileSync(opts.save, output, 'utf-8');
          console.log(`\nSaved to ${opts.save}`);
        }
      } else if (opts.hover) {
        // --hover: capture style diff when hovering selector
        const before = await page.evaluate(snapshotElementStyle, opts.hover);
        if (!before) {
          console.error(`Error: selector "${opts.hover}" not found`);
          process.exit(1);
        }
        try {
          await page.hover(opts.hover, { timeout: 5000 });
        } catch (err) {
          console.error(`Warning: hover failed (${err.message}), proceeding anyway`);
        }
        await page.waitForTimeout(500);
        const after = await page.evaluate(snapshotElementStyle, opts.hover);
        const output = formatHoverDiff(opts.hover, before, after);
        console.log(output);
        if (opts.save) {
          fs.writeFileSync(opts.save, output, 'utf-8');
          console.log(`\nSaved to ${opts.save}`);
        }
      } else if (opts.describe) {
        let extras = null;
        try { extras = await page.evaluate(collectComputedExtras); } catch (_) { extras = null; }
        const output = describeTree(tree, opts.url, opts.viewport, extras);
        console.log(output);
        if (opts.save) {
          fs.writeFileSync(opts.save, output, 'utf-8');
          console.log(`\nSaved to ${opts.save}`);
        }
      } else if (opts.problems) {
        // Feature 2: --problems mode
        const problems = [];
        collectProblems(tree, problems);
        // Z-index conflicts between fixed/sticky elements
        const zConflicts = detectZConflicts(tree);
        problems.push(...zConflicts);
        const output = formatProblems(problems, opts.url, opts.viewport);
        console.log(output);

        if (opts.save) {
          fs.writeFileSync(opts.save, output, 'utf-8');
          console.log(`\nSaved to ${opts.save}`);
        }
      } else {
        // Normal tree output
        const output = generateOutput(tree, opts.url, opts.viewport, opts.warnings);

        if (opts.diff) {
          // Feature 1: --diff mode
          const diffResult = diffOutput(output, opts.diff);
          console.log(diffResult);
        } else {
          console.log(output);
        }

        if (opts.save) {
          fs.writeFileSync(opts.save, output, 'utf-8');
          console.log(`\nSaved to ${opts.save}`);
        }
      }

      // Print net capture summary after any analysis mode
      if (opts.net.capture) {
        await page.waitForTimeout(300);
        console.log('\n' + formatNetCapture(netLog, opts.url));
      }
    }

  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    if (browser) {
      if (opts.cdp) {
        // Don't close CDP-connected browser
      } else {
        if (opts.recordVideo && page) {
          try { await page.close(); } catch {}  // finalize recording
          await saveVideoFile(page, opts);
        }
        await browser.close();
      }
    }
  }
}

run();
