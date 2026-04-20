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

const args = process.argv.slice(2);

function parseArgs(args) {
  const opts = {
    url: null,
    viewport: { width: 430, height: 932 },
    depth: 5,
    warnings: true,
    wait: 2000,
    cdp: null,
    save: null,
    diff: null,
    problems: false,
    compare: false,
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
      opts.wait = parseInt(args[++i], 10);
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
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: layout-map <url> [options]
  --viewport WxH    viewport size (default: 430x932)
  --depth N         max tree depth (default: 5)
  --desktop         shortcut for --viewport 1440x900
  --no-warnings     hide warning flags
  --wait N          ms to wait for render (default: 2000)
  --cdp PORT        connect via CDP instead of launching headless
  --save FILE       save output to file (baseline)
  --diff FILE       compare current layout with saved baseline
  --problems        show ONLY detected problems, skip full tree
  --compare         compare mobile (430x932) vs desktop (1440x900)`);
      process.exit(0);
    } else if (!a.startsWith('--') && !opts.url) {
      opts.url = a;
    }
  }

  if (!opts.url) {
    console.error('Error: URL required. Usage: layout-map <url> [options]');
    process.exit(1);
  }

  return opts;
}

function extractLayout(maxDepth) {
  // This function runs inside page.evaluate
  function rgbToHex(rgb) {
    const match = rgb.match(/(\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return rgb;
    return '#' + [match[1], match[2], match[3]]
      .map(n => parseInt(n).toString(16).padStart(2, '0'))
      .join('');
  }

  function walk(el, depth) {
    if (depth > maxDepth) return null;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return null;

    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    const x = Math.round(rect.left);
    const y = Math.round(rect.top);
    if (w === 0 && h === 0) return null;

    const tag = el.tagName.toLowerCase();

    // Build meaningful selector: prefer role/aria/testid/text over CSS-in-JS classes
    const id = el.id && el.id.length < 20 ? `#${el.id}` : '';
    const role = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    const titleAttr = el.getAttribute('title');
    const testId = el.getAttribute('data-testid') || el.getAttribute('testID');
    const placeholder = el.getAttribute('placeholder');
    const type = el.getAttribute('type');

    // Get text content — direct text first, then innerText for leaf-like elements
    let textContent = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) { // TEXT_NODE
        const t = node.textContent.trim();
        if (t) { textContent = t; break; }
      }
    }
    // For buttons/links/headings without direct text, try innerText
    const labelTags = new Set(['button','a','h1','h2','h3','h4','h5','h6','label','th']);
    if (!textContent && (labelTags.has(tag) || role === 'button' || role === 'link' || role === 'heading')) {
      const inner = (el.innerText || '').trim().split('\n')[0];
      if (inner) textContent = inner;
    }
    // For divs that look like buttons (small, colored bg, few children)
    if (!textContent && tag === 'div' && el.children.length <= 2 && h <= 60) {
      const inner = (el.innerText || '').trim().split('\n')[0];
      if (inner && inner.length < 40) textContent = inner;
    }
    if (textContent.length > 30) textContent = textContent.slice(0, 27) + '...';

    // Check if class is CSS-in-JS (hashed) — skip it
    const firstClass = el.classList[0] || '';
    const isCssInJs = /^css-|^_|^r-|^styled-/.test(firstClass);
    const cls = !id && firstClass && !isCssInJs ? `.${firstClass}` : '';

    // Build identifier: best available label
    let label = '';
    if (testId) label = `[${testId}]`;
    else if (ariaLabel && ariaLabel.length < 30) label = `"${ariaLabel}"`;
    else if (role && role !== 'generic' && role !== 'none') label = `(${role})`;
    else if (placeholder) label = `"${placeholder}"`;
    else if (type && tag === 'input') label = `(${type})`;
    else if (textContent) label = `"${textContent}"`;

    const selector = `${tag}${id || cls}${label ? ' ' + label : ''}`;

    let layout = '';
    if (style.display.includes('flex')) {
      layout = style.flexDirection === 'column' || style.flexDirection === 'column-reverse' ? 'flex-col' : 'flex-row';
      if (style.flexWrap === 'wrap') layout += '+wrap';
    } else if (style.display.includes('grid')) {
      const cols = style.gridTemplateColumns.split(' ').filter(c => c !== '' && c !== 'none').length;
      if (cols > 0) layout = `grid-${cols}col`;
      else layout = 'grid';
    }
    // Scrollable containers
    const ovfX = style.overflowX;
    const ovfY = style.overflowY;
    if (ovfX === 'auto' || ovfX === 'scroll') layout += ' scroll-x';
    if (ovfY === 'auto' || ovfY === 'scroll') layout += ' scroll-y';

    const props = [];

    const bg = style.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      props.push(`bg:${rgbToHex(bg)}`);
    }

    const textTags = new Set(['h1','h2','h3','h4','h5','h6','p','span','a','button','label','li','td','th','input','textarea']);
    const fontSize = parseInt(style.fontSize);
    const fontWeight = parseInt(style.fontWeight);
    if (fontSize && textTags.has(tag)) {
      const weight = fontWeight >= 600 ? `/${fontWeight}` : '';
      props.push(`font:${fontSize}${weight}`);
    }

    const colorTags = new Set(['h1','h2','h3','h4','h5','h6','p','span','a','button','label']);
    if (colorTags.has(tag)) {
      const color = style.color;
      if (color) props.push(rgbToHex(color));
    }

    // Alignment (only for flex/grid — skip defaults)
    if (layout) {
      const jc = style.justifyContent;
      const ai = style.alignItems;
      if (jc && jc !== 'normal' && jc !== 'flex-start' && jc !== 'start') {
        const jcMap = {'center':'jc:center','flex-end':'jc:end','end':'jc:end','space-between':'jc:between','space-around':'jc:around','space-evenly':'jc:evenly'};
        if (jcMap[jc]) props.push(jcMap[jc]);
      }
      if (ai && ai !== 'normal' && ai !== 'stretch' && ai !== 'start' && ai !== 'flex-start') {
        const aiMap = {'center':'ai:center','flex-end':'ai:end','end':'ai:end','baseline':'ai:baseline'};
        if (aiMap[ai]) props.push(aiMap[ai]);
      }
    }

    const gap = parseInt(style.gap);
    if (gap > 0) props.push(`gap:${gap}`);

    // Margin
    const mt = parseInt(style.marginTop);
    const mr = parseInt(style.marginRight);
    const mb = parseInt(style.marginBottom);
    const ml = parseInt(style.marginLeft);
    if (mt > 0 || mr > 0 || mb > 0 || ml > 0) {
      if (mt === mr && mr === mb && mb === ml) {
        props.push(`m:${mt}`);
      } else if (mt === mb && ml === mr && mt === 0) {
        props.push(`mx:${ml}`);
      } else if (mt === mb && ml === mr && ml === 0) {
        props.push(`my:${mt}`);
      } else {
        // Show only non-zero sides
        const parts = [];
        if (mt > 0) parts.push(`mt:${mt}`);
        if (mr > 0) parts.push(`mr:${mr}`);
        if (mb > 0) parts.push(`mb:${mb}`);
        if (ml > 0) parts.push(`ml:${ml}`);
        props.push(parts.join(' '));
      }
    }

    // Padding
    const pt = parseInt(style.paddingTop);
    const pr = parseInt(style.paddingRight);
    const pb = parseInt(style.paddingBottom);
    const pl = parseInt(style.paddingLeft);
    if (pt > 0 || pr > 0 || pb > 0 || pl > 0) {
      if (pt === pr && pr === pb && pb === pl) {
        props.push(`p:${pt}`);
      } else if (pt === pb && pl === pr) {
        props.push(`p:${pt},${pl}`);
      } else {
        const parts = [];
        if (pt > 0) parts.push(`pt:${pt}`);
        if (pr > 0) parts.push(`pr:${pr}`);
        if (pb > 0) parts.push(`pb:${pb}`);
        if (pl > 0) parts.push(`pl:${pl}`);
        props.push(parts.join(' '));
      }
    }

    const radius = parseInt(style.borderRadius);
    if (radius > 0) props.push(`r:${radius}`);

    // Feature 4: Border
    const bw = parseInt(style.borderWidth) || parseInt(style.borderTopWidth) || 0;
    const bc = style.borderColor;
    if (bw > 0 && bc && bc !== 'rgba(0, 0, 0, 0)') {
      props.push(`border:${bw}px ${rgbToHex(bc)}`);
    }

    // Feature 5: Z-index
    const zIndex = style.zIndex;
    if (zIndex && zIndex !== 'auto' && parseInt(zIndex) !== 0) {
      props.push(`z:${zIndex}`);
    }

    // Feature 6: Position (fixed/absolute/sticky)
    const pos = style.position;
    if (pos === 'fixed' || pos === 'absolute' || pos === 'sticky') {
      const top = parseInt(style.top);
      const left = parseInt(style.left);
      let posStr = pos;
      if (!isNaN(top) || !isNaN(left)) {
        posStr += `(${isNaN(top)?'_':top},${isNaN(left)?'_':left})`;
      }
      props.push(posStr);
    }

    // Feature 7: Opacity
    const opacity = parseFloat(style.opacity);
    if (opacity < 1 && opacity >= 0) {
      props.push(`opacity:${opacity}`);
    }

    const warnings = [];
    const vw = window.innerWidth;
    // Only warn overflow if parent is NOT scrollable
    const parentOvf = el.parentElement ? window.getComputedStyle(el.parentElement).overflowX : '';
    const parentScrollable = parentOvf === 'auto' || parentOvf === 'scroll';
    if (w > vw + 2 && !parentScrollable) warnings.push(`overflow! (${w}>${vw})`);
    if (style.overflow === 'hidden' && (el.scrollWidth > w + 2 || el.scrollHeight > h + 2)) {
      warnings.push('hidden-clip');
    }

    // Warnings: tiny-tap, tiny-text, offscreen, no-label, clickable-div, spacing, ghost, z-conflict
    const interactiveTags = new Set(['button', 'a', 'input', 'select', 'textarea']);
    const hasClickHandler = el.getAttribute('onclick') || el.getAttribute('tabindex');
    const isInteractive = interactiveTags.has(tag) || role === 'button' || role === 'link' || hasClickHandler;
    if (isInteractive && (w < 44 || h < 44) && w > 0 && h > 0) {
      warnings.push(`tiny-tap (${w}x${h}<44)`);
    }
    // Tiny text: any element with computed font-size < 12px that has visible text
    if (fontSize && fontSize < 12 && w > 0 && h > 0) {
      const hasText = textContent || (el.innerText || '').trim().length > 0;
      if (hasText) warnings.push(`tiny-text (${fontSize}px)`);
    }
    if (w > 0 && (x + w < 0 || x > vw)) {
      warnings.push(`offscreen (x:${x})`);
    }
    if (isInteractive && !textContent && !ariaLabel && !titleAttr && !placeholder && tag !== 'input') {
      warnings.push('no-label');
    }
    // Clickable div without role: div/span with onclick but no button/link role
    if ((tag === 'div' || tag === 'span') && hasClickHandler && !role) {
      warnings.push('clickable-no-role');
    }
    // Inconsistent spacing: siblings with varying margins
    // (collected at parent level in post-processing)

    // Ghost element: opacity:0 but covers significant area
    if (opacity === 0 && w > 100 && h > 100) {
      warnings.push(`ghost (${w}x${h} invisible)`);
    }

    const children = [];
    for (const child of el.children) {
      const c = walk(child, depth + 1);
      if (c) children.push(c);
    }

    return { selector, w, h, x, y, layout, props, warnings, children, tag, isInteractive: !!isInteractive };
  }

  return walk(document.body, 0);
}

function flatten(node) {
  if (!node || !node.children) return node;
  node.children = node.children.map(flatten);

  while (
    node.children.length === 1 &&
    node.selector.startsWith('div') &&
    !node.selector.includes('"') &&
    !node.selector.includes('#') &&
    !node.selector.includes('[') &&
    !node.selector.includes('(') &&
    node.props.length === 0 &&
    node.warnings.length === 0
  ) {
    const child = node.children[0];
    node = child;
  }
  return node;
}

function formatTree(node, indent, lines, showWarnings) {
  const parts = [`[${node.selector}]`, `${node.w}×${node.h}`];
  if (node.layout) parts.push(node.layout);
  parts.push(...node.props);
  if (showWarnings) parts.push(...node.warnings.map(w => `⚠️ ${w}`));

  lines.push(`${indent}${parts.join(' ')}`);

  const children = node.children || [];
  let i = 0;
  while (i < children.length) {
    const child = children[i];
    let runCount = 1;
    while (i + runCount < children.length && children[i + runCount].selector === child.selector) {
      runCount++;
    }

    const isSpecific = child.selector !== 'div' && child.selector !== 'span' && child.selector !== 'section';
    if (runCount >= 3 && isSpecific) {
      formatTree(child, indent + '  ', lines, showWarnings);
      lines.push(`${indent}  ...×${runCount - 1} more ${child.selector}`);
      i += runCount;
    } else {
      for (let j = 0; j < runCount; j++) {
        formatTree(children[i + j], indent + '  ', lines, showWarnings);
      }
      i += runCount;
    }
  }
}

function generateOutput(tree, url, viewport, showWarnings) {
  const flatTree = flatten(tree);
  const lines = [];
  lines.push(`PAGE: ${url} (viewport: ${viewport.width}×${viewport.height})`);
  lines.push('─'.repeat(40));
  formatTree(flatTree, '', lines, showWarnings);
  return lines.join('\n');
}

// Feature 2: --problems mode — collect all warnings from tree
function collectProblems(node, problems) {
  if (!node) return;
  for (const w of (node.warnings || [])) {
    problems.push({
      type: w.split(' ')[0].replace('!', '').replace(/[()]/g, ''),
      selector: node.selector,
      w: node.w,
      h: node.h,
      x: node.x || 0,
      y: node.y || 0,
      detail: w,
    });
  }

  // Inconsistent spacing: check siblings have varying mt/mb
  const children = node.children || [];
  if (children.length >= 3) {
    const margins = children.map(c => {
      const mtProp = (c.props || []).find(p => typeof p === 'string' && /^mt:\d+/.test(p));
      return mtProp ? parseInt(mtProp.replace('mt:', '')) : 0;
    }).filter((v, i) => i > 0); // skip first child (no mt expected)

    const nonZero = margins.filter(m => m > 0);
    if (nonZero.length >= 2) {
      const unique = [...new Set(nonZero)];
      if (unique.length >= 2) {
        problems.push({
          type: 'spacing',
          selector: node.selector,
          w: node.w, h: node.h, x: node.x || 0, y: node.y || 0,
          detail: `inconsistent-spacing (mt: ${unique.join(', ')}px)`,
        });
      }
    }
  }

  for (const child of children) {
    collectProblems(child, problems);
  }
}

// Z-index conflict detection: fixed/sticky elements overlapping
function collectZElements(node, list) {
  if (!node) return;
  const propsStr = (node.props || []).join(' ');
  const zMatch = propsStr.match(/z:(\d+)/);
  const isFixed = propsStr.includes('fixed') || propsStr.includes('sticky');
  if (zMatch && isFixed) {
    list.push({ z: parseInt(zMatch[1]), selector: node.selector, y: node.y || 0, h: node.h });
  }
  for (const child of (node.children || [])) {
    collectZElements(child, list);
  }
}

function detectZConflicts(tree) {
  const zElements = [];
  collectZElements(tree, zElements);
  const conflicts = [];
  for (let i = 0; i < zElements.length; i++) {
    for (let j = i + 1; j < zElements.length; j++) {
      const a = zElements[i], b = zElements[j];
      // Check if they could overlap vertically
      const aBottom = a.y + a.h;
      const bBottom = b.y + b.h;
      const overlaps = !(aBottom < b.y || bBottom < a.y);
      if (overlaps || (a.z > 0 && b.z > 0)) {
        const higher = a.z >= b.z ? a : b;
        const lower = a.z >= b.z ? b : a;
        conflicts.push({
          type: 'z-conflict',
          selector: `${lower.selector} (z:${lower.z}) vs ${higher.selector} (z:${higher.z})`,
          w: 0, h: 0, x: 0, y: lower.y,
          detail: `z-conflict: ${lower.selector} z:${lower.z} may be hidden behind ${higher.selector} z:${higher.z}`,
        });
      }
    }
  }
  return conflicts;
}

function formatProblems(problems, url, viewport) {
  const lines = [];
  lines.push(`PROBLEMS: ${url} (viewport: ${viewport.width}×${viewport.height})`);
  lines.push('─'.repeat(40));

  const types = ['overflow', 'hidden-clip', 'tiny-tap', 'tiny-text', 'offscreen', 'no-label', 'clickable-no-role', 'ghost', 'spacing', 'z-conflict'];
  const byType = {};
  for (const t of types) byType[t] = [];
  for (const p of problems) {
    const key = types.find(t => p.type.startsWith(t)) || p.type;
    if (byType[key]) byType[key].push(p);
    else {
      if (!byType[p.type]) byType[p.type] = [];
      byType[p.type].push(p);
    }
  }

  for (const t of types) {
    const items = byType[t] || [];
    if (items.length === 0) {
      lines.push(`✅ No ${t} found`);
    } else {
      for (const p of items) {
        let desc = '';
        if (t === 'tiny-tap') desc = ` — min 44×44 for touch`;
        else if (t === 'overflow') desc = ` — ${p.w} > ${viewport.width} viewport`;
        else if (t === 'no-label') desc = ` — needs text, aria-label, or title`;
        else if (t === 'clickable-no-role') desc = ` — add role="button" for accessibility`;
        else if (t === 'ghost') desc = ` — invisible element covering content`;
        else if (t === 'spacing') desc = ` — siblings have different margins`;
        else if (t === 'z-conflict') desc = ` — may overlap`;
        lines.push(`⚠️ ${t}: [${p.selector}] ${p.w}×${p.h} at (${p.x}, ${p.y})${desc}`);
      }
    }
  }

  lines.push(`Total: ${problems.length} problem${problems.length !== 1 ? 's' : ''}`);
  return lines.join('\n');
}

// Feature 1: --diff mode
function diffOutput(current, baselinePath) {
  let baseline;
  try {
    baseline = fs.readFileSync(baselinePath, 'utf-8');
  } catch (e) {
    console.error(`Error: cannot read baseline file: ${baselinePath}`);
    process.exit(1);
  }

  const currentLines = current.split('\n');
  const baselineLines = baseline.split('\n');
  const maxLen = Math.max(currentLines.length, baselineLines.length);

  const changes = [];
  for (let i = 0; i < maxLen; i++) {
    const bl = baselineLines[i] || undefined;
    const cl = currentLines[i] || undefined;

    if (bl === cl) continue;

    if (bl === undefined) {
      changes.push({ idx: i, type: '+', line: cl });
    } else if (cl === undefined) {
      changes.push({ idx: i, type: '-', line: bl });
    } else {
      changes.push({ idx: i, type: '~', oldLine: bl, newLine: cl });
    }
  }

  if (changes.length === 0) {
    return 'No layout changes detected.';
  }

  const output = [];
  for (const ch of changes) {
    // 1 line context above
    const ctxIdx = ch.idx - 1;
    const ctxLine = (ctxIdx >= 0 && ctxIdx < currentLines.length) ? currentLines[ctxIdx] : null;
    if (ctxLine !== undefined && ctxLine !== null) {
      // Only add context if not already the previous output line
      const lastOutput = output[output.length - 1];
      if (lastOutput !== `  ${ctxLine}`) {
        output.push(`  ${ctxLine}`);
      }
    }

    if (ch.type === '+') {
      output.push(`+ ${ch.line}`);
    } else if (ch.type === '-') {
      output.push(`- ${ch.line}`);
    } else if (ch.type === '~') {
      output.push(`- ${ch.oldLine}`);
      output.push(`+ ${ch.newLine}`);
    }
  }

  return output.join('\n');
}

async function extractTreeFromPage(page, opts) {
  await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(opts.wait);
  return await page.evaluate(extractLayout, opts.depth);
}

async function run() {
  const opts = parseArgs(args);
  let browser, context, page;

  try {
    if (opts.compare) {
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

      const tree = await extractTreeFromPage(page, opts);

      if (!tree) {
        console.error('Error: Could not extract layout (body not found or invisible)');
        process.exit(1);
      }

      if (opts.problems) {
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
