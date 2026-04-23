const fs = require('fs');

function extractLayout(maxDepth) {
  // This function runs inside page.evaluate
  // Manual oklab/oklch → sRGB hex (Chromium canvas sometimes can't parse these)
  function parseModernColor(str) {
    const ok = str.match(/^(oklab|oklch)\(\s*([^)]+)\)/i);
    if (!ok) return null;
    const fn = ok[1].toLowerCase();
    // Split on whitespace or slash; support "L a b / alpha" or "L C H / alpha"
    const parts = ok[2].replace('/', ' / ').split(/\s+/).filter(Boolean);
    // parts: [L, a|C, b|H] possibly followed by ['/', alpha]
    const toNum = (v, max = 1) => {
      if (typeof v !== 'string') return NaN;
      if (v.endsWith('%')) return parseFloat(v) / 100 * max;
      return parseFloat(v);
    };
    let L = toNum(parts[0], 1);
    let a, b;
    if (fn === 'oklab') {
      a = toNum(parts[1]);
      b = toNum(parts[2]);
    } else {
      const C = toNum(parts[1]);
      const H = toNum(parts[2]); // degrees
      const rad = (H * Math.PI) / 180;
      a = C * Math.cos(rad);
      b = C * Math.sin(rad);
    }
    if ([L, a, b].some(v => isNaN(v))) return null;

    // OKLab → linear sRGB
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l3 = l_ ** 3, m3 = m_ ** 3, s3 = s_ ** 3;
    let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
    let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
    let bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;
    // linear → sRGB gamma
    const toSrgb = (c) => {
      if (!isFinite(c)) return 0;
      c = Math.max(0, Math.min(1, c));
      return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    };
    r = Math.round(toSrgb(r) * 255);
    g = Math.round(toSrgb(g) * 255);
    bl = Math.round(toSrgb(bl) * 255);
    return '#' + [r, g, bl].map(n => n.toString(16).padStart(2, '0')).join('');
  }
  // Resolve any CSS color to [r, g, b, a] (0-255, alpha 0-1) — supports oklab via parseModernColor
  function resolveColor(str) {
    if (!str) return null;
    let m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/);
    if (m) return [+m[1], +m[2], +m[3], m[4] !== undefined ? parseFloat(m[4]) : 1];
    try {
      __colorCanvas.fillStyle = '#000';
      __colorCanvas.fillStyle = str;
      const r = __colorCanvas.fillStyle;
      const hm = r.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      if (hm) return [parseInt(hm[1], 16), parseInt(hm[2], 16), parseInt(hm[3], 16), 1];
      m = r.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/);
      if (m) return [+m[1], +m[2], +m[3], m[4] !== undefined ? parseFloat(m[4]) : 1];
    } catch (_) {}
    const hex = parseModernColor(str);
    if (hex) {
      const hm = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      if (hm) return [parseInt(hm[1], 16), parseInt(hm[2], 16), parseInt(hm[3], 16), 1];
    }
    return null;
  }
  // Relative luminance (WCAG 2.1)
  function relLum(r, g, b) {
    const f = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrastRatio(fg, bg) {
    const la = relLum(fg[0], fg[1], fg[2]);
    const lb = relLum(bg[0], bg[1], bg[2]);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }
  // Composite fg (with alpha) over bg → effective color
  function blend(fg, bg) {
    if (fg[3] >= 0.999) return fg;
    const a = fg[3];
    return [
      Math.round(fg[0] * a + bg[0] * (1 - a)),
      Math.round(fg[1] * a + bg[1] * (1 - a)),
      Math.round(fg[2] * a + bg[2] * (1 - a)),
      1,
    ];
  }
  // Find nearest opaque ancestor bg color (fallback: white)
  function findAncestorBg(el) {
    let p = el.parentElement;
    while (p) {
      const s = window.getComputedStyle(p);
      const c = resolveColor(s.backgroundColor);
      if (c && c[3] >= 0.8) return c;
      p = p.parentElement;
    }
    return [255, 255, 255, 1];
  }
  const __colorCanvas = document.createElement('canvas').getContext('2d');
  const __colorResolver = document.createElement('div');
  __colorResolver.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;';
  document.body.appendChild(__colorResolver);
  const __colorCache = new Map();
  function rgbToHex(rgb) {
    if (!rgb) return rgb;
    if (__colorCache.has(rgb)) return __colorCache.get(rgb);
    const input = rgb;
    let match = rgb.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!match) {
      // Canvas fallback
      try {
        __colorCanvas.fillStyle = '#000';
        __colorCanvas.fillStyle = rgb;
        const resolved = __colorCanvas.fillStyle;
        if (/^#[0-9a-f]{6}$/i.test(resolved) && resolved !== '#000000') {
          __colorCache.set(input, resolved.toLowerCase());
          return resolved.toLowerCase();
        }
        match = resolved.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      } catch (_) {}
    }
    if (!match) {
      // DOM fallback: browsers normalize `color` to rgb() in computed style
      try {
        __colorResolver.style.color = '';
        __colorResolver.style.color = rgb;
        const computed = getComputedStyle(__colorResolver).color;
        match = computed.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      } catch (_) {}
    }
    if (!match) {
      // Manual conversion for oklab/oklch (Chromium canvas/DOM may refuse)
      const manual = parseModernColor(rgb);
      if (manual) {
        __colorCache.set(input, manual);
        return manual;
      }
      const fnMatch = rgb.match(/^(oklab|oklch|lab|lch|color|hwb|hsl)\(/i);
      const out = fnMatch ? `~${fnMatch[1]}` : rgb.slice(0, 20);
      __colorCache.set(input, out);
      return out;
    }
    const out = '#' + [match[1], match[2], match[3]]
      .map(n => parseInt(n).toString(16).padStart(2, '0'))
      .join('');
    __colorCache.set(input, out);
    return out;
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

    // Box shadow — elevation hint
    const shadowRaw = style.boxShadow;
    if (shadowRaw && shadowRaw !== 'none') {
      const shMatch = shadowRaw.match(/(-?\d+)px\s+(-?\d+)px\s+(\d+)px/);
      if (shMatch) {
        const blur = parseInt(shMatch[3]);
        const level = blur >= 20 ? 'lg' : blur >= 8 ? 'md' : 'sm';
        props.push(`shadow:${level}(${blur})`);
      } else {
        props.push('shadow');
      }
    }

    // Background image / gradient
    const bgImg = style.backgroundImage;
    if (bgImg && bgImg !== 'none') {
      if (bgImg.startsWith('linear-gradient')) {
        const colors = [...bgImg.matchAll(/rgba?\([^)]+\)/g)]
          .slice(0, 2)
          .map(m => rgbToHex(m[0]));
        props.push(`bg-grad:${colors.join('→') || 'linear'}`);
      } else if (bgImg.startsWith('radial-gradient')) {
        props.push('bg-grad:radial');
      } else if (bgImg.startsWith('url(')) {
        const urlMatch = bgImg.match(/url\(["']?([^"')]+)["']?\)/);
        if (urlMatch) {
          const fn = urlMatch[1].split('/').pop().split('?')[0].slice(0, 24);
          props.push(`bg-img:${fn}`);
        } else {
          props.push('bg-img');
        }
      }
    }

    // Backdrop filter (glass/blur)
    const bdFilter = style.backdropFilter || style.webkitBackdropFilter;
    if (bdFilter && bdFilter !== 'none') {
      const blurMatch = bdFilter.match(/blur\((\d+(?:\.\d+)?)(px)?\)/);
      if (blurMatch) props.push(`blur:${Math.round(parseFloat(blurMatch[1]))}`);
      else props.push('backdrop');
    }

    // Transform (only non-identity)
    const transformRaw = style.transform;
    if (transformRaw && transformRaw !== 'none') {
      const matrixMatch = transformRaw.match(/^matrix\(([^)]+)\)/);
      const scaleKw = transformRaw.match(/scale\(([\d.]+)\)/);
      const rotKw = transformRaw.match(/rotate\((-?[\d.]+)deg\)/);
      const tfBits = [];
      if (matrixMatch) {
        const [a, b, , , tx, ty] = matrixMatch[1].split(',').map(p => parseFloat(p.trim()));
        const scale = Math.sqrt(a * a + b * b);
        const rotDeg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
        if (Math.abs(scale - 1) > 0.01) tfBits.push(`scale:${scale.toFixed(2)}`);
        if (Math.abs(rotDeg) > 0) tfBits.push(`rot:${rotDeg}°`);
        if (Math.abs(tx) > 1 || Math.abs(ty) > 1) tfBits.push(`tr:${Math.round(tx)},${Math.round(ty)}`);
      } else {
        if (scaleKw) tfBits.push(`scale:${scaleKw[1]}`);
        if (rotKw) tfBits.push(`rot:${rotKw[1]}°`);
      }
      if (tfBits.length) props.push(tfBits.join(' '));
    }

    // Text styling details (line-height, transform, decoration)
    if (fontSize && textTags.has(tag)) {
      const lhRaw = parseFloat(style.lineHeight);
      if (lhRaw && !isNaN(lhRaw) && fontSize > 0) {
        const ratio = lhRaw / fontSize;
        if (ratio >= 0.5 && ratio <= 3 && Math.abs(ratio - 1.2) > 0.1 && Math.abs(ratio - 1) > 0.05) {
          props.push(`lh:${ratio.toFixed(1)}`);
        }
      }
      const tt = style.textTransform;
      if (tt === 'uppercase') props.push('upper');
      else if (tt === 'lowercase') props.push('lower');
      else if (tt === 'capitalize') props.push('capitalize');

      const td = style.textDecorationLine || style.textDecoration || '';
      const tdFirst = td.split(' ')[0];
      if (tdFirst === 'underline' || tdFirst === 'line-through') props.push(tdFirst);

      const letterSp = parseFloat(style.letterSpacing);
      if (!isNaN(letterSp) && Math.abs(letterSp) >= 0.5) {
        props.push(`tracking:${letterSp > 0 ? '+' : ''}${letterSp.toFixed(1)}`);
      }
    }

    // <img> / <svg> specifics
    if (tag === 'img') {
      const natW = el.naturalWidth || 0;
      const natH = el.naturalHeight || 0;
      const src = el.getAttribute('src') || '';
      const alt = el.getAttribute('alt') || '';
      const fn = src ? src.split('/').pop().split('?')[0].slice(0, 24) : '';
      let info = 'img';
      if (natW && natH) info += `:${natW}×${natH}`;
      if (fn) info += ` ${fn}`;
      if (alt) info += ` alt:"${alt.slice(0, 20)}"`;
      props.push(info);
      const objFit = style.objectFit;
      if (objFit && objFit !== 'fill') props.push(`fit:${objFit}`);
    } else if (tag === 'svg') {
      const vb = el.getAttribute('viewBox');
      props.push(vb ? `svg:${vb}` : 'svg');
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

    // WCAG contrast ratio (text only; ignore empty/whitespace nodes)
    if (fontSize && textContent && textContent.length >= 2 && opacity > 0.3) {
      const fg = resolveColor(style.color);
      if (fg && fg[3] >= 0.3) {
        const bg = findAncestorBg(el);
        const effectiveFg = blend(fg, bg);
        const ratio = contrastRatio(effectiveFg, bg);
        const isLarge = fontSize >= 24 || (fontSize >= 18.67 && fontWeight >= 700);
        const threshold = isLarge ? 3.0 : 4.5;
        if (ratio < threshold) {
          const fgStr = rgbToHex(`rgb(${effectiveFg[0]}, ${effectiveFg[1]}, ${effectiveFg[2]})`);
          const bgStr = rgbToHex(`rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`);
          warnings.push(`low-contrast (${ratio.toFixed(2)}:1 ${fgStr} on ${bgStr}, need ${threshold})`);
        }
      }
    }

    const children = [];
    for (const child of el.children) {
      const c = walk(child, depth + 1);
      if (c) children.push(c);
    }

    // Raw style for --describe and contrast detector (kept separate from display props)
    const bgHex = (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') ? rgbToHex(bg) : null;
    const colorRaw = style.color;
    const fgHex = colorRaw ? rgbToHex(colorRaw) : null;
    const fgAlpha = (() => {
      const m = colorRaw && colorRaw.match(/rgba\([^)]+,\s*([\d.]+)\)/);
      return m ? parseFloat(m[1]) : 1;
    })();
    const style_ = {
      bg: bgHex,
      fg: fgHex,
      fgAlpha,
      fontSize: fontSize || null,
      fontWeight: fontWeight || null,
      hasShadow: !!(shadowRaw && shadowRaw !== 'none'),
      hasBgImage: !!(bgImg && bgImg !== 'none'),
      radius: parseInt(style.borderRadius) || 0,
      textContent: textContent || '',
    };

    // Per-tag metadata (for describe sections: Links, Forms, Icons, etc.)
    const meta = {};
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href) meta.href = href.length > 120 ? href.slice(0, 117) + '...' : href;
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      meta.input = {
        type: el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text'),
        name: el.getAttribute('name') || null,
        placeholder: el.getAttribute('placeholder') || null,
        required: el.hasAttribute('required'),
        pattern: el.getAttribute('pattern') || null,
        min: el.getAttribute('min') || null,
        max: el.getAttribute('max') || null,
        minLength: el.getAttribute('minlength') || null,
        maxLength: el.getAttribute('maxlength') || null,
      };
    }
    if (tag === 'form') {
      meta.form = {
        action: el.getAttribute('action') || null,
        method: (el.getAttribute('method') || 'get').toLowerCase(),
        id: el.id || null,
      };
    }
    if (tag === 'svg') {
      const paths = el.querySelectorAll('path, rect, circle, polygon, polyline, line, ellipse');
      const firstPath = el.querySelector('path');
      const firstD = firstPath ? (firstPath.getAttribute('d') || '').slice(0, 80) : '';
      const iconClass = [...el.classList].find(c =>
        /^(icon|fa|lucide|feather|material|bi|mdi|heroicon)-/.test(c)
      );
      const parentIcon = el.parentElement && [...el.parentElement.classList].find(c =>
        /icon|btn|button/.test(c)
      );
      meta.svg = {
        viewBox: el.getAttribute('viewBox') || null,
        paths: paths.length,
        firstD,
        ariaLabel: el.getAttribute('aria-label') || null,
        title: (el.querySelector('title') && el.querySelector('title').textContent) || null,
        iconClass: iconClass || null,
        parentHint: parentIcon || null,
      };
    }
    if (bgImg && bgImg.startsWith('linear-gradient')) {
      const dirMatch = bgImg.match(/linear-gradient\(\s*([^,]+),/);
      const colors = [...bgImg.matchAll(/rgba?\([^)]+\)/g)].slice(0, 4).map(m => rgbToHex(m[0]));
      meta.grad = {
        type: 'linear',
        direction: dirMatch ? dirMatch[1].trim() : null,
        colors,
      };
    }
    // Component signature (for clustering): tag + first class + direct-child tags
    const childTags = [];
    for (const c of children) {
      const t = c.tag || '';
      const cls = (c.selector.match(/\.([a-zA-Z0-9_-]+)/) || [])[1];
      childTags.push(cls ? `${t}.${cls}` : t);
    }
    const firstClassSig = (el.classList[0] && !/^css-|^_|^r-|^styled-/.test(el.classList[0])) ? `.${el.classList[0]}` : '';
    meta.sig = `${tag}${firstClassSig}:[${childTags.join(',')}]`;

    // Raw stable attributes — let lib/outside build queryable selectors
    const attrs = {
      id: el.id || null,
      ariaLabel: ariaLabel || null,
      testId: testId || null,
      role: role || null,
      placeholder: placeholder || null,
      name: el.getAttribute('name') || null,
      href: tag === 'a' ? (el.getAttribute('href') || null) : null,
      type: tag === 'input' ? (el.getAttribute('type') || null) : null,
    };

    return { selector, w, h, x, y, layout, props, warnings, children, tag, isInteractive: !!isInteractive, style: style_, meta, attrs };
  }

  return walk(document.body, 0);
}

// Build a CSS selector a dev/AI can actually use. Prefer stable attrs.
function buildStableSelector(node) {
  if (!node) return '';
  const a = node.attrs || {};
  const tag = node.tag || '*';
  const escape = s => String(s).replace(/"/g, '\\"');
  if (a.testId) return `[data-testid="${escape(a.testId)}"]`;
  if (a.id && a.id.length < 40 && /^[a-zA-Z][\w-]*$/.test(a.id)) return `#${a.id}`;
  if (a.ariaLabel && a.ariaLabel.length < 60) return `${tag}[aria-label="${escape(a.ariaLabel)}"]`;
  if (a.name && (tag === 'input' || tag === 'textarea' || tag === 'select')) return `${tag}[name="${escape(a.name)}"]`;
  if (a.placeholder) return `${tag}[placeholder="${escape(a.placeholder)}"]`;
  if (a.href && tag === 'a') {
    const h = a.href;
    if (h.length < 80) return `a[href="${escape(h)}"]`;
  }
  if (a.role) return `${tag}[role="${escape(a.role)}"]`;
  // fall back to text selector (Playwright/Testing-Library syntax, dev-friendly)
  const textMatch = (node.selector || '').match(/"([^"]+)"/);
  const text = textMatch ? textMatch[1].replace('...', '') : '';
  if (text && text.length < 40) return `${tag}:has-text("${escape(text)}")`;
  return tag;
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

function firstSubtreeText(node) {
  if (!node) return '';
  const t = node.style && node.style.textContent;
  if (t && t.length >= 2) return t;
  for (const c of (node.children || [])) {
    const ct = firstSubtreeText(c);
    if (ct) return ct;
  }
  return '';
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
      // Surface the first non-empty text of each collapsed sibling — so nav/menu labels aren't lost
      const extraTexts = [];
      for (let j = 1; j < runCount; j++) {
        const sib = children[i + j];
        const t = firstSubtreeText(sib);
        if (t) extraTexts.push(`"${t}"`);
      }
      const suffix = extraTexts.length ? ` (${extraTexts.join(', ')})` : '';
      lines.push(`${indent}  ...×${runCount - 1} more ${child.selector}${suffix}`);
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
      stableSelector: buildStableSelector(node),
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
          stableSelector: buildStableSelector(node),
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

  const types = ['overflow', 'hidden-clip', 'tiny-tap', 'tiny-text', 'low-contrast', 'offscreen', 'no-label', 'clickable-no-role', 'ghost', 'spacing', 'z-conflict'];
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
        else if (t === 'spacing') desc = p.detail && p.detail.includes('(') ? ` — ${p.detail.slice(p.detail.indexOf('(') + 1, p.detail.lastIndexOf(')'))}` : ` — siblings have different margins`;
        else if (t === 'z-conflict') desc = ` — may overlap`;
        else if (t === 'low-contrast') {
          const m = p.detail && p.detail.match(/\(([^)]+)\)/);
          desc = m ? ` — ${m[1]}` : ` — WCAG AA fails`;
        }
        const stable = p.stableSelector && p.stableSelector !== p.selector
          ? `  ⟶  ${p.stableSelector}`
          : '';
        lines.push(`⚠️ ${t}: [${p.selector}] ${p.w}×${p.h} at (${p.x}, ${p.y})${desc}${stable}`);
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

// Collect computed-style extras for --describe (runs in page context via page.evaluate).
// Self-contained: no external helpers. Returns { fonts, pageBg, buttonPairs, surfaces }.
function collectComputedExtras() {
  const canvas = document.createElement('canvas').getContext('2d');
  function resolveRgba(str) {
    if (!str) return null;
    let m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/);
    if (m) return [+m[1], +m[2], +m[3], m[4] !== undefined ? parseFloat(m[4]) : 1];
    try {
      canvas.fillStyle = '#000';
      canvas.fillStyle = str;
      const r = canvas.fillStyle;
      const hm = r.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      if (hm) return [parseInt(hm[1], 16), parseInt(hm[2], 16), parseInt(hm[3], 16), 1];
      m = r.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/);
      if (m) return [+m[1], +m[2], +m[3], m[4] !== undefined ? parseFloat(m[4]) : 1];
    } catch (_) {}
    return null;
  }
  function rgbaToHex(c) {
    if (!c) return null;
    return '#' + [c[0], c[1], c[2]].map(n => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
  }
  function relLum(r, g, b) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function ratio(fg, bg) {
    const la = relLum(fg[0], fg[1], fg[2]);
    const lb = relLum(bg[0], bg[1], bg[2]);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }
  function blend(fg, bg) {
    if (fg[3] >= 0.999) return [fg[0], fg[1], fg[2], 1];
    const a = fg[3];
    return [
      Math.round(fg[0] * a + bg[0] * (1 - a)),
      Math.round(fg[1] * a + bg[1] * (1 - a)),
      Math.round(fg[2] * a + bg[2] * (1 - a)),
      1,
    ];
  }
  function ancestorBg(el) {
    let p = el.parentElement;
    while (p) {
      const s = getComputedStyle(p);
      const c = resolveRgba(s.backgroundColor);
      if (c && c[3] > 0.05) return c;
      p = p.parentElement;
    }
    return [255, 255, 255, 1];
  }
  function selfBg(el) {
    const s = getComputedStyle(el);
    const c = resolveRgba(s.backgroundColor);
    if (c && c[3] > 0.05) return c;
    return ancestorBg(el);
  }
  function isVisible(el) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }
  function firstFamily(stack) {
    if (!stack) return '(unknown)';
    const first = stack.split(',')[0].trim();
    return first.replace(/^["']|["']$/g, '');
  }
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 4) {
      let sel = cur.tagName.toLowerCase();
      if (cur.classList && cur.classList.length) {
        const cls = Array.from(cur.classList).filter(c => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
        if (cls.length) sel += '.' + cls.join('.');
      }
      parts.unshift(sel);
      cur = cur.parentElement;
      if (cur === document.body) break;
    }
    return parts.join(' > ');
  }

  // --- Fonts: walk all visible elements with text, group by first family token ---
  const fontMap = new Map(); // family -> { nodes, sizes: Set }
  const all = document.body ? document.body.querySelectorAll('*') : [];
  for (const el of all) {
    if (!isVisible(el)) continue;
    // Only count elements that render their own text (have direct text node child)
    let hasOwnText = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim().length >= 1) { hasOwnText = true; break; }
    }
    if (!hasOwnText) continue;
    const cs = getComputedStyle(el);
    const fam = firstFamily(cs.fontFamily);
    const size = Math.round(parseFloat(cs.fontSize) || 0);
    let rec = fontMap.get(fam);
    if (!rec) { rec = { nodes: 0, sizes: new Set() }; fontMap.set(fam, rec); }
    rec.nodes++;
    if (size) rec.sizes.add(size);
  }
  const fonts = [...fontMap.entries()]
    .sort((a, b) => b[1].nodes - a[1].nodes)
    .map(([family, rec]) => ({
      family,
      nodes: rec.nodes,
      sizes: [...rec.sizes].sort((a, b) => a - b),
    }));

  // --- Page background ---
  let pageBg = null;
  if (document.body) {
    const b = resolveRgba(getComputedStyle(document.body).backgroundColor);
    if (b && b[3] > 0.05) pageBg = b;
  }
  if (!pageBg && document.documentElement) {
    const h = resolveRgba(getComputedStyle(document.documentElement).backgroundColor);
    if (h && h[3] > 0.05) pageBg = h;
  }
  if (!pageBg) pageBg = [255, 255, 255, 1];
  const pageBgHex = rgbaToHex(pageBg);

  // --- Button pairs ---
  const CLICK_LABEL_RX = /войти|submit|отправить|send|save|click|open|подать|продолжить|continue|войти|sign in|log in|signin|login|subscribe|buy|купить|заказать|register|регистр/i;
  const seen = new Set();
  const buttonPairs = [];
  const candidates = [];
  // Native buttons, role=button, links with text, clickable divs
  for (const el of all) {
    if (!isVisible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const aria = el.getAttribute('aria-label') || '';
    let isBtn = false;
    if (tag === 'button') isBtn = true;
    else if (role === 'button') isBtn = true;
    else if (tag === 'a') {
      const t = (el.textContent || '').trim();
      if (t.length >= 1) isBtn = true;
    } else if (tag === 'input') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'submit' || t === 'button') isBtn = true;
    } else if (el.onclick || el.hasAttribute('onclick')) {
      isBtn = true;
    } else if (aria && CLICK_LABEL_RX.test(aria)) {
      isBtn = true;
    }
    if (!isBtn) continue;
    const txtRaw = ((tag === 'input' ? (el.value || el.getAttribute('value') || '') : (el.textContent || '')) || aria).trim().replace(/\s+/g, ' ');
    if (!txtRaw) continue;
    const txt = txtRaw.length > 30 ? txtRaw.slice(0, 27) + '...' : txtRaw;
    const cs = getComputedStyle(el);
    const fg = resolveRgba(cs.color);
    if (!fg) continue;
    const bg = selfBg(el);
    const fgEff = blend(fg, bg);
    const key = `${txt}|${rgbaToHex(fgEff)}|${rgbaToHex(bg)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fontSize = parseFloat(cs.fontSize) || 14;
    const fontWeight = parseInt(cs.fontWeight) || 400;
    const threshold = (fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700)) ? 3.0 : 4.5;
    const r = ratio(fgEff, bg);
    candidates.push({
      text: txt,
      fg: rgbaToHex(fgEff),
      bg: rgbaToHex(bg),
      ratio: r,
      threshold,
      pass: r >= threshold,
      selector: cssPath(el),
    });
  }
  // Cap to 20 to keep output readable
  buttonPairs.push(...candidates.slice(0, 20));

  // --- Surface backgrounds: top-level chrome (nav/header/footer/aside + role=navigation) ---
  const surfaces = [];
  const surfSel = 'nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]';
  const seenSurf = new Set();
  for (const el of document.querySelectorAll(surfSel)) {
    if (!isVisible(el)) continue;
    const cs = getComputedStyle(el);
    const bg = resolveRgba(cs.backgroundColor);
    if (!bg || bg[3] < 0.05) continue;
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || 900;
    let label;
    if (tag === 'nav' || role === 'navigation') {
      label = (rect.top > vh * 0.6) ? 'bottom nav' : 'nav';
    } else if (tag === 'header' || role === 'banner') {
      label = 'header';
    } else if (tag === 'footer' || role === 'contentinfo') {
      label = 'footer';
    } else if (tag === 'aside') {
      label = 'aside';
    } else {
      label = tag;
    }
    const hex = rgbaToHex(bg);
    const key = label + '|' + hex;
    if (seenSurf.has(key)) continue;
    seenSurf.add(key);
    surfaces.push({ label, bg: hex });
  }

  return { fonts, pageBg: pageBgHex, buttonPairs, surfaces };
}

// --describe mode: synthesize human-readable design summary from tree
function describeTree(tree, url, viewport, extras) {
  const stats = {
    bgArea: new Map(),
    fgArea: new Map(),
    typography: new Map(),
    shadows: 0,
    gradients: 0,
    bgImages: 0,
    imgs: [],
    svgs: 0,
    buttons: 0,
    links: 0,
    inputs: 0,
    headings: new Map(),
    fixed: 0,
    sticky: 0,
    gridContainers: 0,
    flexContainers: 0,
    radiusCounts: new Map(),
    borderCount: 0,
    gaps: new Map(),
    paddings: new Map(),
    maxY: 0,
    maxDepth: 0,
    totalNodes: 0,
    interactiveTinyTap: 0,
    hasBackdropFilter: 0,
    textBySize: new Map(), // "size/weight" → ordered unique [{text, y, w}]
    textSeen: new Set(),   // dedup by text
    ctaTexts: new Set(),   // interactive (<a>, <button>) above fold
    linksList: [],         // {text, href, external}
    linkSeen: new Set(),
    forms: [],             // {action, method, id, inputs:[{type,name,placeholder,required}]}
    svgIcons: [],          // {label, size, paths}
    componentSigs: new Map(), // sig → {count, tag, samplesText:[], minY, maxY}
    gradientsList: [],     // {direction, colors, area}
  };

  // Derive origin for external link detection
  let pageOrigin = '';
  try { pageOrigin = new URL(url).origin; } catch (e) {}

  function firstText(node) {
    if (!node) return '';
    const s = node.style || {};
    if (s.textContent && s.textContent.length >= 2) return s.textContent;
    for (const c of (node.children || [])) {
      const t = firstText(c);
      if (t) return t;
    }
    return '';
  }

  function classifyIcon(m, sizeLabel) {
    if (!m) return { label: 'svg', paths: 0 };
    if (m.ariaLabel) return { label: `"${m.ariaLabel}"`, paths: m.paths };
    if (m.title) return { label: `"${m.title}"`, paths: m.paths };
    if (m.iconClass) return { label: m.iconClass, paths: m.paths };
    if (m.parentHint) {
      const hint = m.parentHint.toLowerCase();
      if (/arrow|chevron|caret|back|forward|next|prev/.test(hint)) return { label: `arrow-ish (${hint})`, paths: m.paths };
      if (/close|cross|x-/.test(hint)) return { label: `close-ish (${hint})`, paths: m.paths };
      if (/menu|burger|hamburger/.test(hint)) return { label: `menu-ish (${hint})`, paths: m.paths };
      if (/search|magnif/.test(hint)) return { label: `search-ish (${hint})`, paths: m.paths };
      if (/user|profile|avatar|account/.test(hint)) return { label: `user-ish (${hint})`, paths: m.paths };
      if (/cart|bag|basket/.test(hint)) return { label: `cart-ish (${hint})`, paths: m.paths };
      if (/heart|fav|like/.test(hint)) return { label: `heart-ish (${hint})`, paths: m.paths };
      return { label: `icon (${hint})`, paths: m.paths };
    }
    // Path-count heuristic for generic icons
    if (m.paths === 1) return { label: `simple icon (1 path, ${sizeLabel})`, paths: 1 };
    if (m.paths >= 6) return { label: `complex icon (${m.paths} paths, ${sizeLabel})`, paths: m.paths };
    return { label: `icon (${m.paths} paths, ${sizeLabel})`, paths: m.paths };
  }

  function walk(node, depth) {
    if (!node) return;
    stats.totalNodes++;
    if (depth > stats.maxDepth) stats.maxDepth = depth;
    const bottom = (node.y || 0) + (node.h || 0);
    if (bottom > stats.maxY) stats.maxY = bottom;

    const s = node.style || {};
    const area = (node.w || 0) * (node.h || 0);
    const propsStr = (node.props || []).join(' ');

    if (s.bg && area > 0) {
      stats.bgArea.set(s.bg, (stats.bgArea.get(s.bg) || 0) + area);
    }
    if (s.fg && s.textContent && area > 0) {
      stats.fgArea.set(s.fg, (stats.fgArea.get(s.fg) || 0) + area);
      if (s.fontSize) {
        const key = `${s.fontSize}/${s.fontWeight || 400}`;
        stats.typography.set(key, (stats.typography.get(key) || 0) + area);
      }
    }
    // Collect text content above/near fold (first screen + buffer)
    if (s.textContent && s.textContent.length >= 2 && s.fontSize && (node.y || 0) < 1400) {
      const text = s.textContent;
      const key = `${s.fontSize}/${s.fontWeight || 400}`;
      const seenKey = `${key}|${text}`;
      if (!stats.textSeen.has(seenKey)) {
        stats.textSeen.add(seenKey);
        if (!stats.textBySize.has(key)) stats.textBySize.set(key, []);
        stats.textBySize.get(key).push({ text, y: node.y || 0, tag: node.tag });
      }
      if ((node.tag === 'a' || node.tag === 'button' || node.isInteractive) && (node.y || 0) < 1000) {
        stats.ctaTexts.add(text);
      }
    }
    if (s.hasShadow) stats.shadows++;
    if (s.hasBgImage) {
      if (propsStr.includes('bg-grad')) stats.gradients++;
      else if (propsStr.includes('bg-img')) stats.bgImages++;
    }
    if (s.radius > 0) {
      stats.radiusCounts.set(s.radius, (stats.radiusCounts.get(s.radius) || 0) + 1);
    }
    if (propsStr.includes('backdrop') || /\bblur:\d/.test(propsStr)) stats.hasBackdropFilter++;

    const tag = node.tag;
    const m = node.meta || {};
    if (tag === 'img') {
      stats.imgs.push({ w: node.w, h: node.h });
    } else if (tag === 'svg') {
      stats.svgs++;
      const sizeLabel = `${Math.round(node.w || 0)}×${Math.round(node.h || 0)}`;
      const classified = classifyIcon(m.svg, sizeLabel);
      stats.svgIcons.push({ ...classified, size: sizeLabel, y: node.y || 0 });
    } else if (tag === 'button') {
      stats.buttons++;
    } else if (tag === 'a') {
      stats.links++;
      const href = m.href || '';
      const text = firstText(node).slice(0, 60);
      if (text && href && !stats.linkSeen.has(text + '|' + href)) {
        stats.linkSeen.add(text + '|' + href);
        let external = false;
        if (/^https?:\/\//i.test(href)) {
          try { external = new URL(href).origin !== pageOrigin; } catch (e) { external = true; }
        }
        stats.linksList.push({ text, href, external, y: node.y || 0 });
      }
    } else if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      stats.inputs++;
    } else if (/^h[1-6]$/.test(tag)) {
      stats.headings.set(tag, (stats.headings.get(tag) || 0) + 1);
    }
    if (tag === 'form' && m.form) {
      // Collect all descendant inputs
      const inputs = [];
      (function collect(n) {
        if (!n) return;
        const t = n.tag;
        if (t === 'input' || t === 'textarea' || t === 'select') {
          const im = (n.meta && n.meta.input) || {};
          inputs.push({
            type: im.type || t,
            name: im.name || null,
            placeholder: im.placeholder || null,
            required: !!im.required,
          });
        }
        for (const c of (n.children || [])) collect(c);
      })(node);
      stats.forms.push({ ...m.form, inputs });
    }
    if (m.grad) {
      stats.gradientsList.push({
        direction: m.grad.direction,
        colors: m.grad.colors,
        area: area,
      });
    }
    // Component signature clustering — track spread + unique texts to distinguish
    // structural-dupe (chrome) from real repeating components (list/grid).
    if (m.sig) {
      const rec = stats.componentSigs.get(m.sig) || { count: 0, tag, samples: [], uniqueTexts: new Set(), minY: Infinity, maxY: 0 };
      rec.count++;
      const t = firstText(node).slice(0, 40);
      if (t) {
        rec.uniqueTexts.add(t);
        if (rec.samples.length < 3 && !rec.samples.includes(t)) rec.samples.push(t);
      }
      if ((node.y || 0) < rec.minY) rec.minY = node.y || 0;
      if ((node.y || 0) > rec.maxY) rec.maxY = node.y || 0;
      stats.componentSigs.set(m.sig, rec);
    }

    if (/\bfixed(\(|\b)/.test(propsStr)) stats.fixed++;
    if (/\bsticky(\(|\b)/.test(propsStr)) stats.sticky++;
    const layout = node.layout || '';
    if (layout.includes('grid')) stats.gridContainers++;
    else if (layout.includes('flex')) stats.flexContainers++;

    const gm = propsStr.match(/\bgap:(\d+)/);
    if (gm) {
      const g = parseInt(gm[1]);
      stats.gaps.set(g, (stats.gaps.get(g) || 0) + 1);
    }
    const pSingle = propsStr.match(/\bp:(\d+)(?![\d,])/);
    if (pSingle) {
      const p = parseInt(pSingle[1]);
      stats.paddings.set(p, (stats.paddings.get(p) || 0) + 1);
    }
    if (/\bborder:/.test(propsStr)) stats.borderCount++;

    for (const w of (node.warnings || [])) {
      if (w.startsWith('tiny-tap')) stats.interactiveTinyTap++;
    }

    for (const child of (node.children || [])) walk(child, depth + 1);
  }
  walk(tree, 0);

  const lines = [];
  lines.push(`DESIGN SUMMARY: ${url} (viewport: ${viewport.width}×${viewport.height})`);
  lines.push('─'.repeat(40));

  // Palette
  lines.push('Palette:');
  const topBg = [...stats.bgArea.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topBg.length) {
    const total = topBg.reduce((a, [, v]) => a + v, 0) +
      [...stats.bgArea.entries()].slice(3).reduce((a, [, v]) => a + v, 0);
    topBg.forEach(([color, area], i) => {
      const pct = total > 0 ? Math.round(area / total * 100) : 0;
      const label = i === 0 ? 'Dominant bg' : i === 1 ? 'Secondary bg' : 'Tertiary bg';
      lines.push(`  ${label.padEnd(14)} ${color} (${pct}%)`);
    });
  } else {
    lines.push('  (no explicit bg — likely white/transparent)');
  }
  const topFg = [...stats.fgArea.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (topFg.length) {
    lines.push(`  Text colors:   ${topFg.map(([c]) => c).join(', ')}`);
  }

  // Typography
  lines.push('');
  lines.push('Typography:');
  const typoEntries = [...stats.typography.entries()].sort((a, b) => {
    const [sa] = a[0].split('/').map(Number);
    const [sb] = b[0].split('/').map(Number);
    return sb - sa;
  });
  if (typoEntries.length) {
    const hierarchy = typoEntries.slice(0, 6).map(([k]) => k).join(' → ');
    lines.push(`  Scale: ${hierarchy}`);
    const sizes = [...new Set(typoEntries.map(([k]) => parseInt(k.split('/')[0])))]
      .sort((a, b) => a - b);
    lines.push(`  Sizes used: ${sizes.join(', ')}px (${sizes.length} levels)`);
  } else {
    lines.push('  (no rendered text detected)');
  }
  if (stats.headings.size) {
    const hs = [...stats.headings.entries()]
      .sort()
      .map(([t, n]) => `${t.toUpperCase()}×${n}`)
      .join(', ');
    lines.push(`  Headings: ${hs}`);
  }

  // Layout
  lines.push('');
  lines.push('Layout:');
  lines.push(`  Total height: ${stats.maxY}px | Max depth: ${stats.maxDepth} | Nodes: ${stats.totalNodes}`);
  const containers = [];
  if (stats.flexContainers) containers.push(`${stats.flexContainers} flex`);
  if (stats.gridContainers) containers.push(`${stats.gridContainers} grid`);
  if (containers.length) lines.push(`  Containers: ${containers.join(', ')}`);
  if (stats.fixed || stats.sticky) {
    lines.push(`  Positioned: ${stats.fixed} fixed, ${stats.sticky} sticky`);
  }

  // Surfaces
  if (stats.shadows || stats.radiusCounts.size || stats.borderCount || stats.hasBackdropFilter) {
    lines.push('');
    lines.push('Surfaces:');
    if (stats.shadows) lines.push(`  Elevation: ${stats.shadows} shadowed element(s)`);
    if (stats.radiusCounts.size) {
      const radii = [...stats.radiusCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([r, n]) => `${r}px×${n}`);
      lines.push(`  Rounded: ${radii.join(', ')}`);
    }
    if (stats.borderCount) lines.push(`  Borders: ${stats.borderCount}`);
    if (stats.hasBackdropFilter) lines.push(`  Backdrop blur: ${stats.hasBackdropFilter}`);
  }

  // Imagery
  if (stats.imgs.length || stats.svgs || stats.gradients || stats.bgImages) {
    lines.push('');
    lines.push('Imagery:');
    if (stats.imgs.length) {
      const preview = stats.imgs.slice(0, 3).map(i => `${i.w}×${i.h}`).join(', ');
      lines.push(`  <img>: ${stats.imgs.length} (${preview}${stats.imgs.length > 3 ? ', …' : ''})`);
    }
    if (stats.svgs) lines.push(`  <svg>: ${stats.svgs}`);
    if (stats.gradients) lines.push(`  Gradients: ${stats.gradients}`);
    if (stats.bgImages) lines.push(`  BG images: ${stats.bgImages}`);
  }

  // Gradient ASCII ramps (show actual color progression)
  if (stats.gradientsList.length) {
    lines.push('');
    lines.push('Gradients:');
    const ramps = stats.gradientsList
      .slice()
      .sort((a, b) => b.area - a.area)
      .slice(0, 3);
    const shades = ['█', '▓', '▒', '░'];
    for (const g of ramps) {
      const cs = g.colors.filter(Boolean);
      if (!cs.length) continue;
      const ramp = cs.map((c, i) => shades[Math.min(i, shades.length - 1)].repeat(4)).join('');
      const dir = g.direction || 'default';
      lines.push(`  ${ramp}  ${dir}: ${cs.join(' → ')}`);
    }
  }

  // Icons — classified SVG usage
  if (stats.svgIcons.length) {
    lines.push('');
    lines.push('Icons:');
    const iconCounts = new Map();
    for (const ic of stats.svgIcons) {
      iconCounts.set(ic.label, (iconCounts.get(ic.label) || 0) + 1);
    }
    const top = [...iconCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    for (const [label, n] of top) {
      lines.push(`  ${n > 1 ? `×${n} ` : '    '}${label}`);
    }
    if (iconCounts.size > 10) lines.push(`  … +${iconCounts.size - 10} more distinct icons`);
  }

  // Links — internal / external breakdown + top texts
  if (stats.linksList.length) {
    lines.push('');
    lines.push('Links:');
    const internal = stats.linksList.filter(l => !l.external);
    const external = stats.linksList.filter(l => l.external);
    lines.push(`  Total: ${stats.linksList.length} unique (${internal.length} internal, ${external.length} external)`);
    const topInternal = internal.slice(0, 10);
    if (topInternal.length) {
      lines.push('  Internal (first 10):');
      for (const l of topInternal) {
        const hrefShort = l.href.length > 40 ? l.href.slice(0, 37) + '…' : l.href;
        lines.push(`    "${l.text}" → ${hrefShort}`);
      }
    }
    const topExternal = external.slice(0, 5);
    if (topExternal.length) {
      lines.push('  External (first 5):');
      for (const l of topExternal) {
        let domain = l.href;
        try { domain = new URL(l.href).hostname; } catch (e) {}
        lines.push(`    "${l.text}" → ${domain}`);
      }
    }
  }

  // Forms — spec with inputs
  if (stats.forms.length) {
    lines.push('');
    lines.push('Forms:');
    stats.forms.forEach((f, i) => {
      const label = f.id ? `#${f.id}` : `form[${i}]`;
      const ep = f.action ? `${f.method.toUpperCase()} ${f.action}` : `${f.method.toUpperCase()} (no action)`;
      lines.push(`  ${label}: ${ep} — ${f.inputs.length} input(s)`);
      for (const inp of f.inputs.slice(0, 8)) {
        const req = inp.required ? ' *' : '';
        const name = inp.name || '(unnamed)';
        const ph = inp.placeholder ? ` placeholder="${inp.placeholder.slice(0, 30)}"` : '';
        lines.push(`    ${inp.type.padEnd(10)} ${name}${req}${ph}`);
      }
      if (f.inputs.length > 8) lines.push(`    … +${f.inputs.length - 8} more`);
    });
  }

  // Components — repeating structural patterns (3+ occurrences)
  const repeatedSigs = [...stats.componentSigs.entries()]
    .filter(([sig, rec]) => rec.count >= 3 && !/^(div|span|p|br|svg|path|g|i):\[\]$/.test(sig))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6);
  if (repeatedSigs.length) {
    lines.push('');
    lines.push('Components (repeating patterns):');
    for (const [sig, rec] of repeatedSigs) {
      const sigShort = sig.length > 55 ? sig.slice(0, 52) + '…' : sig;
      const sampleTxt = rec.samples.length ? ` samples:"${rec.samples.slice(0, 3).join('", "')}"` : '';
      const spread = rec.maxY - rec.minY;
      const uniqueCnt = rec.uniqueTexts ? rec.uniqueTexts.size : 0;
      // Label pattern type: list (spread + diverse text) vs chrome (clustered + identical text) vs repeated-chrome
      let kind = '';
      if (spread > 200 && uniqueCnt >= Math.min(rec.count, 3)) kind = ' kind=list';
      else if (spread < 80 && uniqueCnt <= 1) kind = ' kind=chrome-dup';
      else if (uniqueCnt <= 1) kind = ' kind=repeated-chrome';
      else kind = ' kind=mixed';
      lines.push(`  ×${rec.count}  ${sigShort} y:${rec.minY}–${rec.maxY}${kind}${sampleTxt}`);
    }
  }

  // Interaction
  lines.push('');
  lines.push('Interaction:');
  lines.push(`  Buttons: ${stats.buttons} | Links: ${stats.links} | Inputs: ${stats.inputs}`);
  if (stats.interactiveTinyTap) lines.push(`  Tiny-tap warnings: ${stats.interactiveTinyTap}`);

  // Spacing
  if (stats.gaps.size || stats.paddings.size) {
    lines.push('');
    lines.push('Spacing:');
    if (stats.gaps.size) {
      const topGaps = [...stats.gaps.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([g]) => g)
        .sort((a, b) => a - b);
      lines.push(`  Common gaps: ${topGaps.join(', ')}px`);
    }
    if (stats.paddings.size) {
      const topP = [...stats.paddings.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([p]) => p)
        .sort((a, b) => a - b);
      lines.push(`  Common padding: ${topP.join(', ')}px`);
    }
  }

  // Content above fold — actual rendered texts grouped by typography
  if (stats.textBySize.size) {
    lines.push('');
    lines.push('Content (first screen):');
    const sortedKeys = [...stats.textBySize.keys()].sort((a, b) => {
      const [sa] = a.split('/').map(Number);
      const [sb] = b.split('/').map(Number);
      return sb - sa;
    });
    const foldY = viewport.height;
    for (const key of sortedKeys) {
      const items = stats.textBySize.get(key)
        .filter(it => it.y < foldY)
        .sort((a, b) => a.y - b.y);
      if (!items.length) continue;
      const texts = items.map(it => it.text);
      const preview = texts.slice(0, 6).map(t => `"${t}"`).join(' · ');
      const more = texts.length > 6 ? ` +${texts.length - 6}` : '';
      lines.push(`  ${key.padEnd(7)} → ${preview}${more}`);
    }
    // Below-fold sample (up to 3 items)
    const belowItems = [];
    for (const arr of stats.textBySize.values()) {
      for (const it of arr) if (it.y >= foldY) belowItems.push(it);
    }
    if (belowItems.length) {
      belowItems.sort((a, b) => a.y - b.y);
      const preview = belowItems.slice(0, 4).map(it => `"${it.text}"`).join(' · ');
      const more = belowItems.length > 4 ? ` +${belowItems.length - 4}` : '';
      lines.push(`  below fold → ${preview}${more}`);
    }
  }

  // --- Extras from computed styles (optional): Fonts, Page background, Button pairs, Surfaces ---
  if (extras && typeof extras === 'object') {
    if (Array.isArray(extras.fonts) && extras.fonts.length) {
      lines.push('');
      lines.push('Fonts (real computed):');
      for (const f of extras.fonts) {
        const sizes = f.sizes && f.sizes.length ? ` — sizes ${f.sizes.join(',')}` : '';
        lines.push(`  ${f.family} (${f.nodes} nodes)${sizes}`);
      }
    }
    if (extras.pageBg) {
      lines.push('');
      lines.push(`Page background: ${extras.pageBg}`);
    }
    if (Array.isArray(extras.buttonPairs) && extras.buttonPairs.length) {
      lines.push('');
      lines.push('Button pairs (fg on bg @ ratio):');
      const maxTxt = Math.min(30, extras.buttonPairs.reduce((m, p) => Math.max(m, (p.text || '').length + 2), 0));
      for (const p of extras.buttonPairs) {
        const quoted = `"${p.text}"`;
        const padded = quoted.padEnd(maxTxt + 2, ' ');
        const status = p.pass ? 'OK' : 'FAIL';
        const r = (typeof p.ratio === 'number') ? p.ratio.toFixed(2) : '?';
        lines.push(`  ${padded} ${p.fg} on ${p.bg} @ ${r}:1 ${status}`);
      }
    }
    if (Array.isArray(extras.surfaces) && extras.surfaces.length) {
      lines.push('');
      lines.push('Surface backgrounds:');
      const maxLbl = extras.surfaces.reduce((m, s) => Math.max(m, (s.label || '').length), 0);
      for (const s of extras.surfaces) {
        lines.push(`  ${(s.label || '').padEnd(maxLbl + 2, ' ')}${s.bg}`);
      }
    }
  }

  return lines.join('\n');
}

async function extractTreeFromPage(page, opts) {
  await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Best-effort wait for network to quiet (SPAs often hydrate after DCL)
  try { await page.waitForLoadState('networkidle', { timeout: 4000 }); } catch {}
  await page.waitForTimeout(opts.wait);
  let tree = await page.evaluate(extractLayout, opts.depth);
  // If tree looks unhydrated (very few nodes, no text), wait and retry once
  function hasRenderedText(n) {
    if (!n) return false;
    const t = n.style && n.style.textContent;
    if (t && t.length >= 2) return true;
    for (const c of (n.children || [])) if (hasRenderedText(c)) return true;
    return false;
  }
  if (tree && !hasRenderedText(tree)) {
    await page.waitForTimeout(2500);
    tree = await page.evaluate(extractLayout, opts.depth);
  }
  return tree;
}

// Snapshot computed style of an element for hover diffing
function snapshotElementStyle(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const props = [
    'color', 'backgroundColor', 'backgroundImage', 'borderColor',
    'borderWidth', 'borderStyle', 'borderRadius', 'boxShadow',
    'opacity', 'transform', 'transition', 'filter', 'backdropFilter',
    'fontSize', 'fontWeight', 'textDecoration', 'letterSpacing',
    'cursor', 'outline', 'outlineOffset', 'padding', 'margin',
  ];
  const snap = {};
  for (const p of props) snap[p] = cs[p];
  snap._rect = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  return snap;
}

function formatHoverDiff(selector, before, after) {
  if (!before || !after) {
    return `HOVER DIFF: selector "${selector}" not found`;
  }
  const lines = [];
  lines.push(`HOVER DIFF: ${selector}`);
  lines.push('─'.repeat(40));
  const keys = Object.keys(before).filter(k => k !== '_rect');
  const changed = [];
  for (const k of keys) {
    if (before[k] !== after[k]) {
      changed.push({ k, before: before[k], after: after[k] });
    }
  }
  const rb = before._rect, ra = after._rect;
  if (rb && ra) {
    if (Math.abs(rb.x - ra.x) > 0.5 || Math.abs(rb.y - ra.y) > 0.5 ||
        Math.abs(rb.w - ra.w) > 0.5 || Math.abs(rb.h - ra.h) > 0.5) {
      changed.push({
        k: 'geometry',
        before: `${Math.round(rb.w)}×${Math.round(rb.h)} @ ${Math.round(rb.x)},${Math.round(rb.y)}`,
        after: `${Math.round(ra.w)}×${Math.round(ra.h)} @ ${Math.round(ra.x)},${Math.round(ra.y)}`,
      });
    }
  }
  if (!changed.length) {
    lines.push('  (no style changes on :hover — static element or JS-driven)');
    return lines.join('\n');
  }
  for (const c of changed) {
    lines.push(`  ${c.k}:`);
    lines.push(`    before: ${c.before}`);
    lines.push(`    after:  ${c.after}`);
  }
  return lines.join('\n');
}

function extractAriaFromDom() {
  // Runs in page context — walks DOM collecting ARIA-relevant attributes
  const INTERESTING_ROLES = /^(button|link|heading|navigation|main|banner|contentinfo|form|search|region|landmark|list|listitem|img|dialog|menu|menuitem|checkbox|radio|switch|tab|tabpanel|textbox|combobox|option|slider|progressbar|alert|status|table|row|cell|columnheader|rowheader)$/i;
  const IMPLICIT_ROLES = {
    a: 'link', button: 'button', nav: 'navigation', main: 'main',
    header: 'banner', footer: 'contentinfo', form: 'form', h1: 'heading',
    h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    img: 'img', input: 'textbox', textarea: 'textbox', select: 'combobox',
    ul: 'list', ol: 'list', li: 'listitem', table: 'table',
    tr: 'row', td: 'cell', th: 'columnheader',
    dialog: 'dialog',
  };
  function getAccessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return (ref.textContent || '').trim();
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') return (el.getAttribute('alt') || '').trim();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'submit' || t === 'button') return el.value || '';
      const labelEl = el.labels && el.labels[0];
      if (labelEl) return (labelEl.textContent || '').trim();
      return el.getAttribute('placeholder') || '';
    }
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
    return txt.length > 80 ? txt.slice(0, 77) + '…' : txt;
  }
  function walk(el, depth) {
    if (depth > 15) return null;
    if (!el || el.nodeType !== 1) return null;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || el.hasAttribute('hidden')) return null;
    if (el.getAttribute('aria-hidden') === 'true') return null;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || IMPLICIT_ROLES[tag];
    const name = role ? getAccessibleName(el) : '';
    const children = [];
    for (const child of el.children) {
      const c = walk(child, depth + 1);
      if (c) {
        if (Array.isArray(c)) children.push(...c);
        else children.push(c);
      }
    }
    if (!role) {
      return children.length ? children : null;
    }
    const out = { role, name, children };
    if (el.hasAttribute('disabled')) out.disabled = true;
    if (el.getAttribute('aria-expanded') === 'true') out.expanded = true;
    if (el.getAttribute('aria-expanded') === 'false') out.expanded = false;
    if (el.hasAttribute('checked')) out.checked = true;
    if (el.getAttribute('aria-selected') === 'true') out.selected = true;
    if (el.getAttribute('aria-pressed') === 'true') out.pressed = true;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.value) out.value = el.value;
    }
    if (/^h[1-6]$/.test(tag)) out.level = parseInt(tag[1]);
    return out;
  }
  const root = walk(document.body, 0);
  return { role: 'WebArea', name: document.title, children: Array.isArray(root) ? root : (root ? [root] : []) };
}

function formatAriaTree(node, indent) {
  indent = indent || '';
  if (!node) return '';
  const lines = [];
  const name = node.name ? ` "${node.name.slice(0, 80)}"` : '';
  const role = node.role || '(no role)';
  const flags = [];
  if (node.disabled) flags.push('disabled');
  if (node.expanded === true) flags.push('expanded');
  if (node.expanded === false) flags.push('collapsed');
  if (node.checked === true) flags.push('checked');
  if (node.selected) flags.push('selected');
  if (node.pressed) flags.push('pressed');
  if (node.focused) flags.push('focused');
  const flagStr = flags.length ? ` [${flags.join(',')}]` : '';
  const value = node.value ? ` =${JSON.stringify(node.value).slice(0, 30)}` : '';
  const levelStr = node.level ? ` h${node.level}` : '';
  lines.push(`${indent}${role}${levelStr}${name}${value}${flagStr}`);
  for (const child of (node.children || [])) {
    lines.push(formatAriaTree(child, indent + '  '));
  }
  return lines.filter(Boolean).join('\n');
}

async function captureViewport(browser, opts, vp) {
  const ctx = await browser.newContext({ viewport: vp });
  const pg = await ctx.newPage();
  try {
    await pg.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pg.waitForTimeout(opts.wait);
    const tree = await pg.evaluate(extractLayout, Math.max(opts.depth, 10));
    if (!tree) return { vp, error: 'extract failed' };
    // Collect compact stats
    let totalNodes = 0, maxY = 0, headings = 0;
    const bgArea = new Map();
    const typos = new Set();
    const navLinks = [];
    (function walk(n) {
      if (!n) return;
      totalNodes++;
      const bottom = (n.y || 0) + (n.h || 0);
      if (bottom > maxY) maxY = bottom;
      const s = n.style || {};
      if (/^h[1-6]$/.test(n.tag)) headings++;
      if (s.bg && n.w && n.h) {
        bgArea.set(s.bg, (bgArea.get(s.bg) || 0) + n.w * n.h);
      }
      if (s.fontSize) typos.add(`${s.fontSize}/${s.fontWeight || 400}`);
      if (n.tag === 'a' && (n.y || 0) < 200 && s.textContent) navLinks.push(s.textContent);
      for (const c of (n.children || [])) walk(c);
    })(tree);
    const topBg = [...bgArea.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
    return {
      vp,
      totalNodes,
      maxY,
      headings,
      typoCount: typos.size,
      topBg,
      navLinks: navLinks.slice(0, 10),
    };
  } finally {
    await ctx.close();
  }
}

function formatSweep(results, url) {
  const lines = [];
  lines.push(`RESPONSIVE SWEEP: ${url}`);
  lines.push('─'.repeat(60));
  lines.push('vp        nodes  maxY    hN  typos  top-bg');
  for (const r of results) {
    if (r.error) {
      lines.push(`${(r.vp.width + 'x' + r.vp.height).padEnd(10)}${r.error}`);
      continue;
    }
    const vpStr = `${r.vp.width}×${r.vp.height}`.padEnd(10);
    const bg = (r.topBg[0] || '—').padEnd(9);
    lines.push(`${vpStr}${String(r.totalNodes).padEnd(7)}${String(r.maxY).padEnd(8)}${String(r.headings).padEnd(4)}${String(r.typoCount).padEnd(7)}${bg}`);
  }
  // Nav link drift
  lines.push('');
  lines.push('Nav links above y<200 per viewport:');
  for (const r of results) {
    if (r.error) continue;
    const vpStr = `${r.vp.width}×${r.vp.height}`.padEnd(10);
    lines.push(`  ${vpStr}${r.navLinks.length ? r.navLinks.map(t => `"${t.slice(0, 18)}"`).join(', ') : '(none)'}`);
  }
  // Height progression
  const heights = results.filter(r => !r.error).map(r => r.maxY);
  if (heights.length >= 2) {
    const min = Math.min(...heights);
    const max = Math.max(...heights);
    lines.push('');
    lines.push(`Total height varies ${min}→${max}px (${Math.round((max - min) / min * 100)}% delta)`);
  }
  return lines.join('\n');
}


// Helper: take a screenshot with optional JPEG/WebP compression and resize via sharp.
async function takeScreenshot(page, file, opts, fullPage) {
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const { execSync } = require('child_process');
  const ext = path.extname(file).toLowerCase();
  const quality = opts.screenshotQuality;
  const maxWidth = opts.screenshotWidth;

  if (ext === '.webp' || maxWidth) {
    const vizorHome = opts.vizorHome || path.join(os.homedir(), '.vizor');
    const sharpPath = path.join(vizorHome, 'node_modules/sharp');
    let sharp;
    try { sharp = require(sharpPath); } catch (_) {
      try {
        process.stderr.write('[vizor] Installing sharp for optimized screenshots (~25MB, one-time)...\n');
        execSync('npm install sharp', { cwd: vizorHome, stdio: 'inherit' });
        sharp = require(sharpPath);
      } catch (err) {
        // fallback: jpeg
        process.stderr.write('[vizor] sharp install failed, falling back to JPEG\n');
        const fallback = file.replace(/\.\w+$/, '.jpg');
        await page.screenshot({ path: fallback, type: 'jpeg', quality: quality || 70, fullPage });
        return fallback;
      }
    }
    const buf = await page.screenshot({ fullPage });
    let img = sharp(buf);
    if (maxWidth) img = img.resize({ width: maxWidth, withoutEnlargement: true });
    img = ext === '.webp' ? img.webp({ quality: quality || 55 }) :
          (ext === '.jpg' || ext === '.jpeg') ? img.jpeg({ quality: quality || 70 }) : img.png();
    await img.toFile(file);
    return file;
  } else if (ext === '.jpg' || ext === '.jpeg') {
    await page.screenshot({ path: file, type: 'jpeg', quality: quality || 70, fullPage });
    return file;
  } else {
    await page.screenshot({ path: file, fullPage });
    return file;
  }
}

// Interactive action runner — applies a sequence of {type, ...args} steps against a Playwright page.
// Returns { ok, steps:[{i, type, status, detail, ms}], failed:<step|null>, consoleLogs:[] }.
async function runActions(context, page, actions, opts = {}) {
  const log = [];
  const maxWait = opts.maxWait || 10000;
  let failed = null;
  const pages = [page];
  let pg = page;

  const consoleLogs = [];
  if (opts.captureConsole) {
    page.on('console', msg => {
      if (opts.captureConsole === 'errors' && msg.type() !== 'error') return;
      consoleLogs.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', err => {
      consoleLogs.push({ type: 'pageerror', text: err.message });
    });
  }

  for (let i = 0; i < actions.length; i++) {
    const step = actions[i];
    const t0 = Date.now();
    const rec = { i, type: step.type, status: 'ok', detail: '', ms: 0 };
    try {
      switch (step.type) {
        case 'goto':
          await pg.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          try { await pg.waitForLoadState('networkidle', { timeout: 3000 }); } catch {}
          rec.detail = step.url;
          break;
        case 'click':
          await pg.locator(step.selector).first().click({ timeout: maxWait });
          rec.detail = step.selector;
          break;
        case 'fill':
          await pg.locator(step.selector).first().fill(step.value, { timeout: maxWait });
          rec.detail = `${step.selector} = "${step.value}"`;
          break;
        case 'type':
          await pg.locator(step.selector).first().pressSequentially(step.value, { timeout: maxWait });
          rec.detail = `${step.selector} += "${step.value}"`;
          break;
        case 'press':
          await pg.keyboard.press(step.key);
          rec.detail = step.key;
          break;
        case 'wait':
          await pg.waitForTimeout(step.ms);
          rec.detail = `${step.ms}ms`;
          break;
        case 'wait-for':
          await pg.locator(step.selector).first().waitFor({ state: step.state || 'visible', timeout: maxWait });
          rec.detail = `${step.selector} (${step.state || 'visible'})`;
          break;
        case 'screenshot': {
          const file = step.file;
          const savedFile = await takeScreenshot(pg, file, opts, !!step.full);
          const fs = require('fs');
          try {
            const stat = fs.statSync(savedFile);
            rec.detail = `${savedFile} (${formatBytes(stat.size)})`;
          } catch (_) {
            rec.detail = savedFile;
          }
          break;
        }
        case 'assert-exists': {
          const count = await pg.locator(step.selector).count();
          if (count === 0) throw new Error(`not found: ${step.selector}`);
          rec.detail = `${step.selector} (${count} match${count !== 1 ? 'es' : ''})`;
          break;
        }
        case 'assert-text': {
          const loc = pg.locator(step.selector).first();
          const text = (await loc.textContent({ timeout: maxWait }) || '').trim();
          const want = (step.value || '').trim();
          if (!text.includes(want)) throw new Error(`text mismatch: "${text.slice(0, 80)}" ∌ "${want}"`);
          rec.detail = `${step.selector} ∋ "${want}"`;
          break;
        }
        case 'assert-url': {
          const cur = pg.url();
          if (!cur.includes(step.value)) throw new Error(`url mismatch: ${cur} ∌ ${step.value}`);
          rec.detail = `url ∋ "${step.value}"`;
          break;
        }
        case 'new-tab': {
          if (!context) throw new Error('new-tab requires a browser context (not available in CDP mode)');
          const newPage = await context.newPage();
          if (step.url) {
            await newPage.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            try { await newPage.waitForLoadState('networkidle', { timeout: 3000 }); } catch {}
          }
          pages.push(newPage);
          pg = newPage;
          rec.detail = step.url || '(blank)';
          break;
        }
        case 'switch-tab': {
          const idx = parseInt(step.index ?? 0, 10);
          if (idx < 0 || idx >= pages.length) throw new Error(`tab ${idx} out of range (${pages.length} open)`);
          pg = pages[idx];
          rec.detail = `→ tab ${idx} (${pg.url()})`;
          break;
        }
        case 'close-tab': {
          const closedIdx = pages.indexOf(pg);
          await pg.close();
          pages.splice(closedIdx, 1);
          if (pages.length === 0) throw new Error('no tabs left after close');
          pg = pages[Math.max(0, closedIdx - 1)];
          rec.detail = `closed tab ${closedIdx}`;
          break;
        }
        case 'get': {
          const loc = pg.locator(step.selector).first();
          const text = await loc.isVisible({ timeout: 2000 }).catch(() => false)
            ? (await loc.textContent({ timeout: maxWait }) || '').trim()
            : '';
          rec.detail = `${step.selector} → "${text}"`;
          break;
        }
        case 'get-attr': {
          const val = await pg.locator(step.selector).first().getAttribute(step.name, { timeout: maxWait });
          rec.detail = `${step.selector}[${step.name}] → "${val ?? '(null)'}"`;
          break;
        }
        case 'assert-visible': {
          const visible = await pg.locator(step.selector).first().isVisible({ timeout: maxWait });
          if (!visible) throw new Error(`not visible: ${step.selector}`);
          rec.detail = step.selector;
          break;
        }
        case 'assert-enabled': {
          const enabled = await pg.locator(step.selector).first().isEnabled({ timeout: maxWait });
          if (!enabled) throw new Error(`not enabled: ${step.selector}`);
          rec.detail = step.selector;
          break;
        }
        case 'assert-checked': {
          const checked = await pg.locator(step.selector).first().isChecked({ timeout: maxWait });
          if (!checked) throw new Error(`not checked: ${step.selector}`);
          rec.detail = step.selector;
          break;
        }
        case 'scroll': {
          const { direction, px } = step;
          if (direction === 'up' || direction === 'down') {
            const dy = direction === 'down' ? (px || 300) : -(px || 300);
            await pg.evaluate((dy) => window.scrollBy(0, dy), dy);
          } else if (direction === 'top') {
            await pg.evaluate(() => window.scrollTo(0, 0));
          } else if (direction === 'bottom') {
            await pg.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          } else {
            // direction is a selector
            await pg.locator(direction).first().scrollIntoViewIfNeeded({ timeout: maxWait });
          }
          rec.detail = `${direction}${px ? ' ' + px + 'px' : ''}`;
          break;
        }
        case 'select': {
          await pg.locator(step.selector).first().selectOption(step.value, { timeout: maxWait });
          rec.detail = `${step.selector} = "${step.value}"`;
          break;
        }
        case 'cookies-save': {
          if (!context) throw new Error('cookies-save requires browser context');
          const cookies = await context.cookies();
          require('fs').writeFileSync(step.file, JSON.stringify(cookies, null, 2));
          rec.detail = `${step.file} (${cookies.length} cookies)`;
          break;
        }
        case 'cookies-load': {
          if (!context) throw new Error('cookies-load requires browser context');
          const cookies = JSON.parse(require('fs').readFileSync(step.file, 'utf-8'));
          await context.addCookies(cookies);
          rec.detail = `${step.file} (${cookies.length} cookies)`;
          break;
        }
        case 'drag': {
          await pg.dragAndDrop(step.source, step.target, { timeout: maxWait });
          rec.detail = `${step.source} → ${step.target}`;
          break;
        }
        case 'upload': {
          const files = Array.isArray(step.files) ? step.files : [step.files];
          await pg.locator(step.selector).first().setInputFiles(files, { timeout: maxWait });
          rec.detail = `${step.selector} ← ${files.join(', ')}`;
          break;
        }
        case 'screenshot-diff': {
          const os = require('os');
          const path = require('path');
          const fs = require('fs');
          const { execSync } = require('child_process');
          const baseline = step.baseline;
          if (!fs.existsSync(baseline)) {
            // No baseline yet — save current screenshot as baseline
            const buf = await pg.screenshot({ fullPage: !!step.full });
            fs.writeFileSync(baseline, buf);
            rec.detail = `baseline saved → ${baseline}`;
            break;
          }
          const vizorHome = opts.vizorHome || path.join(os.homedir(), '.vizor');
          const sharpPath = path.join(vizorHome, 'node_modules/sharp');
          let sharp;
          try { sharp = require(sharpPath); } catch {
            execSync('npm install sharp', { cwd: vizorHome, stdio: 'inherit' });
            sharp = require(sharpPath);
          }
          const currentBuf = await pg.screenshot({ fullPage: !!step.full });
          const baselineBuf = fs.readFileSync(baseline);
          const currentImg = sharp(currentBuf);
          const baselineImg = sharp(baselineBuf);
          const [curMeta, baseMeta] = await Promise.all([currentImg.metadata(), baselineImg.metadata()]);
          if (curMeta.width !== baseMeta.width || curMeta.height !== baseMeta.height) {
            throw new Error(`size mismatch: current ${curMeta.width}x${curMeta.height} vs baseline ${baseMeta.width}x${baseMeta.height}`);
          }
          const [curRaw, baseRaw] = await Promise.all([
            sharp(currentBuf).raw().toBuffer(),
            sharp(baselineBuf).raw().toBuffer(),
          ]);
          let diffPixels = 0;
          const threshold = (step.threshold || 10);
          for (let i = 0; i < curRaw.length; i += 4) {
            const dr = Math.abs(curRaw[i] - baseRaw[i]);
            const dg = Math.abs(curRaw[i+1] - baseRaw[i+1]);
            const db = Math.abs(curRaw[i+2] - baseRaw[i+2]);
            if (dr > threshold || dg > threshold || db > threshold) diffPixels++;
          }
          const totalPixels = curMeta.width * curMeta.height;
          const pct = ((diffPixels / totalPixels) * 100).toFixed(2);
          const maxDiff = step.maxDiff != null ? step.maxDiff : 0.5;
          if (step.saveDiff) {
            fs.writeFileSync(step.saveDiff, currentBuf);
          }
          if (parseFloat(pct) > maxDiff) {
            throw new Error(`pixel diff ${pct}% exceeds threshold ${maxDiff}% (${diffPixels.toLocaleString()} pixels changed)`);
          }
          rec.detail = `${pct}% diff (${diffPixels.toLocaleString()} px) — OK`;
          break;
        }
        default:
          throw new Error(`unknown action: ${step.type}`);
      }
    } catch (err) {
      rec.status = 'fail';
      rec.detail = err.message;
      failed = rec;
    }
    rec.ms = Date.now() - t0;
    log.push(rec);
    if (failed) break;
  }
  return { ok: !failed, steps: log, failed, page: pg, consoleLogs };
}

function formatActionLog(result) {
  const lines = [];
  lines.push(`ACTIONS: ${result.steps.length} step${result.steps.length !== 1 ? 's' : ''} — ${result.ok ? 'OK' : 'FAILED at step ' + (result.failed.i + 1)}`);
  lines.push('─'.repeat(40));
  for (const s of result.steps) {
    const mark = s.status === 'ok' ? '✓' : '✗';
    lines.push(`${mark} ${String(s.i + 1).padStart(2, ' ')}. ${s.type.padEnd(14)} ${s.detail}  (${s.ms}ms)`);
  }
  return lines.join('\n');
}

// Parse a flow file (JSON array of {type, ...} or simplified line format).
function parseFlowFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8').trim();
  if (text.startsWith('[') || text.startsWith('{')) {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : [data];
    return arr.map(normalizeAction);
  }
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const type = parts[0];
    const rest = line.slice(type.length).trim();
    if (type === 'fill' || type === 'type' || type === 'assert-text') {
      const m = rest.match(/^(\S+)\s+(.+)$/);
      if (m) out.push({ type, selector: m[1], value: m[2].replace(/^["']|["']$/g, '') });
    } else if (type === 'wait' || type === 'wait-ms') {
      out.push({ type: 'wait', ms: parseInt(rest, 10) || 500 });
    } else if (type === 'press') {
      out.push({ type, key: rest });
    } else if (type === 'goto') {
      out.push({ type, url: rest });
    } else if (type === 'screenshot') {
      out.push({ type, file: rest });
    } else if (type === 'assert-url') {
      out.push({ type, value: rest });
    } else if (type === 'new-tab') {
      out.push({ type, url: rest });
    } else if (type === 'switch-tab') {
      out.push({ type, index: parseInt(rest, 10) || 0 });
    } else if (type === 'close-tab') {
      out.push({ type });
    } else if (type === 'get') {
      out.push({ type, selector: rest });
    } else if (type === 'get-attr') {
      const m = rest.match(/^(\S+)\s+(\S+)$/);
      if (m) out.push({ type, selector: m[1], name: m[2] });
    } else if (type === 'assert-visible' || type === 'assert-enabled' || type === 'assert-checked') {
      out.push({ type, selector: rest });
    } else if (type === 'scroll') {
      const sParts = rest.split(/\s+/);
      out.push({ type, direction: sParts[0], px: parseInt(sParts[1], 10) || 0 });
    } else if (type === 'select') {
      const m = rest.match(/^(\S+)\s+(.+)$/);
      if (m) out.push({ type, selector: m[1], value: m[2].replace(/^["']|["']$/g, '') });
    } else if (type === 'cookies-save' || type === 'cookies-load') {
      out.push({ type, file: rest });
    } else {
      out.push({ type, selector: rest });
    }
  }
  return out;
}

function normalizeAction(a) {
  if (a.type) return a;
  const keys = ['click', 'fill', 'type', 'press', 'wait', 'wait-for', 'goto', 'screenshot',
    'assert-exists', 'assert-text', 'assert-url', 'new-tab', 'switch-tab', 'close-tab',
    'get', 'get-attr', 'assert-visible', 'assert-enabled', 'assert-checked',
    'scroll', 'select', 'cookies-save', 'cookies-load'];
  for (const k of keys) {
    if (k in a) {
      const rest = { ...a }; delete rest[k];
      if (k === 'fill' || k === 'type') return { type: k, selector: a[k], value: a.value || rest.value || '' };
      if (k === 'press') return { type: 'press', key: a[k] };
      if (k === 'wait') return { type: 'wait', ms: parseInt(a[k], 10) || 500 };
      if (k === 'goto') return { type: 'goto', url: a[k] };
      if (k === 'screenshot') return { type: 'screenshot', file: a[k], full: !!rest.full };
      if (k === 'assert-text') return { type: 'assert-text', selector: a[k], value: a.value || rest.value || '' };
      if (k === 'assert-url') return { type: 'assert-url', value: a[k] };
      if (k === 'new-tab') return { type: 'new-tab', url: a[k] || '' };
      if (k === 'switch-tab') return { type: 'switch-tab', index: parseInt(a[k], 10) || 0 };
      if (k === 'close-tab') return { type: 'close-tab' };
      if (k === 'get') return { type: 'get', selector: a[k] };
      if (k === 'get-attr') return { type: 'get-attr', selector: a[k], name: a.name || rest.name || '' };
      if (k === 'assert-visible') return { type: 'assert-visible', selector: a[k] };
      if (k === 'assert-enabled') return { type: 'assert-enabled', selector: a[k] };
      if (k === 'assert-checked') return { type: 'assert-checked', selector: a[k] };
      if (k === 'scroll') return { type: 'scroll', direction: a[k], px: parseInt(a.px, 10) || 0 };
      if (k === 'select') return { type: 'select', selector: a[k], value: a.value || rest.value || '' };
      if (k === 'cookies-save') return { type: 'cookies-save', file: a[k] };
      if (k === 'cookies-load') return { type: 'cookies-load', file: a[k] };
      return { type: k, selector: a[k], ...rest };
    }
  }
  throw new Error(`flow: unrecognized action keys in ${JSON.stringify(a)}`);
}

function formatBytes(n) {
  if (n < 1024) return n + 'b';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'kb';
  return (n / 1024 / 1024).toFixed(1) + 'mb';
}

function formatNetCapture(netLog, url) {
  const lines = [];
  lines.push(`NET CAPTURE: ${url}`);
  lines.push('─'.repeat(64));
  if (netLog.length === 0) {
    lines.push('  (no XHR/fetch requests captured)');
    return lines.join('\n');
  }
  const col = (s, w) => String(s == null ? '—' : s).padEnd(w).slice(0, w);
  lines.push(`  ${'METHOD'.padEnd(7)} ${'ST'.padEnd(5)} ${'SIZE'.padEnd(8)} ${'MS'.padEnd(6)} URL`);
  for (const r of netLog) {
    const flag = r.blocked ? ' ✗' : r.status >= 500 ? ' !!' : r.status >= 400 ? ' !' : '';
    lines.push(`  ${col(r.method, 7)} ${col(r.blocked ? 'BLK' : r.status, 5)} ${col(r.size != null ? formatBytes(r.size) : null, 8)} ${col(r.ms != null ? r.ms + 'ms' : null, 6)} ${r.shortUrl}${flag}`);
  }
  lines.push('─'.repeat(64));
  const errors = netLog.filter(r => r.blocked || r.status >= 400).length;
  lines.push(`  ${netLog.length} request${netLog.length !== 1 ? 's' : ''}${errors ? `  |  ${errors} error${errors !== 1 ? 's' : ''}` : ''}`);
  return lines.join('\n');
}

module.exports = {
  extractLayout,
  flatten,
  firstSubtreeText,
  formatTree,
  generateOutput,
  collectProblems,
  collectZElements,
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
};
