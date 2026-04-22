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
  extractTreeFromPage,
  snapshotElementStyle,
  formatHoverDiff,
  extractAriaFromDom,
  formatAriaTree,
  captureViewport,
  formatSweep,
  runActions,
  formatActionLog,
  parseFlowFile,
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
    aria: false,
    actions: [],
    actionsLog: false,
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
    } else if (a === '--assert-exists' && args[i + 1]) {
      opts.actions.push({ type: 'assert-exists', selector: args[++i] });
    } else if (a === '--assert-text' && args[i + 2]) {
      opts.actions.push({ type: 'assert-text', selector: args[++i], value: args[++i] });
    } else if (a === '--assert-url' && args[i + 1]) {
      opts.actions.push({ type: 'assert-url', value: args[++i] });
    } else if (a === '--flow' && args[i + 1]) {
      const steps = parseFlowFile(args[++i]);
      opts.actions.push(...steps);
    } else if (a === '--actions-log') {
      opts.actionsLog = true;
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
  --sweep           analyze across 5 viewports (320/430/768/1024/1440)
  --diff FILE       compare current tree with saved baseline

Interactive actions (applied in order, before analysis mode):
  --click SEL               click element
  --fill SEL VAL            clear + fill input
  --type SEL VAL            type into input (no clear)
  --press KEY               press keyboard key (Enter, Tab, ArrowDown, …)
  --goto URL                navigate mid-flow
  --wait-for SEL            wait until SEL visible (10s max)
  --wait-ms N               sleep N milliseconds
  --assert-exists SEL       fail run if SEL missing
  --assert-text SEL TEXT    fail if element text lacks TEXT
  --assert-url TEXT         fail if current URL lacks TEXT
  --screenshot FILE         save PNG to FILE
  --flow FILE               load actions from JSON array or line-based file
  --actions-log             always print the action log (default: only on failure)

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

// true if any of the analysis modes is selected
function hasAnalysisMode(opts) {
  return !!(opts.problems || opts.compare || opts.describe || opts.hover || opts.sweep || opts.aria || opts.diff);
}

async function run() {
  const opts = parseArgs(args);
  let browser, context, page;

  try {
    if (opts.sweep) {
      // --sweep: analyze across multiple viewports
      const viewports = [
        { width: 320, height: 640 },
        { width: 430, height: 932 },
        { width: 768, height: 1024 },
        { width: 1024, height: 768 },
        { width: 1440, height: 900 },
      ];
      browser = await chromium.launch({ headless: true });
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
        browser = await chromium.launch({ headless: true });
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
        browser = await chromium.launch({ headless: true });
        context = await browser.newContext({ viewport: opts.viewport });
        page = await context.newPage();
      }

      // Describe mode benefits from deeper traversal (nav items, hero text often nested)
      if (opts.describe && opts.depth < 12) opts.depth = 12;

      // Initial goto + render wait (extractTreeFromPage does its own goto too — but we need the page
      // loaded before actions run. If actions include an early --goto they'll override cleanly.)
      if (opts.actions.length > 0) {
        await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        try { await page.waitForLoadState('networkidle', { timeout: 4000 }); } catch {}
        await page.waitForTimeout(opts.wait);
        const result = await runActions(page, opts.actions);
        if (!result.ok || opts.actionsLog) {
          console.error(formatActionLog(result));
        }
        if (!result.ok) {
          process.exit(2);
        }
        // If no analysis mode requested and no failure, print the success log and exit.
        if (!hasAnalysisMode(opts)) {
          if (!opts.actionsLog) console.log(formatActionLog(result));
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
        const output = describeTree(tree, opts.url, opts.viewport);
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
    }

  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    if (browser) {
      if (opts.cdp) {
        // Don't close CDP-connected browser
      } else {
        await browser.close();
      }
    }
  }
}

run();
