# Vizor CLI

Lightweight layout analysis tool for AI agents. Extracts page structure, computed styles, and detects layout problems — **without screenshots**.

A single page scan costs ~200 tokens vs ~100K+ tokens for a screenshot. 500x cheaper context for AI-powered UI review.

## Install

```bash
npm install -g vizor-cli
# or just copy vizor.js and run directly
```

Requires [Playwright](https://playwright.dev/) as a peer dependency:
```bash
npm install -g playwright
```

## Usage

```bash
# Basic scan (mobile viewport 430x932)
vizor http://localhost:3000

# Desktop viewport
vizor http://localhost:3000 --desktop

# Custom viewport
vizor http://localhost:3000 --viewport 768x1024

# Problems only (skip full tree)
vizor http://localhost:3000 --problems

# Compare mobile vs desktop
vizor http://localhost:3000 --compare

# Save baseline and diff later
vizor http://localhost:3000 --save baseline.txt
vizor http://localhost:3000 --diff baseline.txt

# Connect to existing browser via CDP
vizor http://localhost:3000 --cdp 9222
```

## Output Example

```
PAGE: http://localhost:3000 (viewport: 430x932)
────────────────────────────────────────
[body] 430x932
  [header.navbar] 430x56 flex-row bg:#1a1a2e jc:between ai:center p:0,20 sticky(0,_) z:100
    [div.logo "MyApp"] 99x28
    [button "Login"] 76x44 flex-col bg:#e94560 jc:center ai:center p:0,16 r:8
  [main] 430x1200 flex-col
    [section.hero] 430x300 flex-col ai:center p:40,16
      [h1 "Welcome"] 398x32 font:28/700 #ffffff mb:8
      [p "Browse our products"] 398x18 font:16 #a0a0b0 mb:24
    [div.cards-grid] 398x424 grid-2col gap:12
      [div.card] 193x214 bg:#ffffff r:12 mb:12
        [div.card-img] 193x120 bg:#dddddd
        [div.card-body] 193x94 p:12
          [div.card-title "Product Name"] 169x16 font:14/600 mb:4
          [div.card-price "$299"] 169x18 font:16/700 #e94560
```

## What It Extracts

For each visible element:
- **Selector**: `tag.class "text"` or `tag#id "aria-label"` (CSS-in-JS classes auto-filtered)
- **Dimensions**: width x height from `getBoundingClientRect()`
- **Layout**: `flex-row`, `flex-col`, `flex-row+wrap`, `grid-Ncol`, `scroll-x`, `scroll-y`
- **Alignment**: `jc:center`, `jc:between`, `ai:center`, `ai:end`
- **Spacing**: `m:16`, `mt:8`, `mx:auto`, `p:12`, `p:8,16`, `gap:12`
- **Visual**: `bg:#hex`, `font:size/weight`, `#hex` (text color), `r:8` (border-radius), `border:1px #hex`, `opacity:0.5`
- **Position**: `fixed(top,left)`, `absolute(top,left)`, `sticky(top,_)`
- **Z-index**: `z:100`

## Problem Detection (10 types)

| Type | What it finds |
|------|--------------|
| `overflow` | Element wider than viewport (without scrollable parent) |
| `hidden-clip` | `overflow:hidden` clips content |
| `tiny-tap` | Interactive element < 44x44px (touch target) |
| `tiny-text` | Font size < 12px |
| `offscreen` | Element completely outside viewport |
| `no-label` | Button/link without text or aria-label |
| `clickable-no-role` | div with onclick but no `role="button"` |
| `ghost` | Large invisible element (opacity:0) covering content |
| `spacing` | Inconsistent margins between siblings |
| `z-conflict` | Fixed/sticky elements with overlapping z-index |

## Options

```
vizor <url> [options]

  --viewport WxH    Viewport size (default: 430x932)
  --depth N         Max tree depth (default: 5)
  --desktop         Shortcut for --viewport 1440x900
  --no-warnings     Hide warning flags in tree output
  --wait N          Wait ms for page render (default: 2000)
  --cdp PORT        Connect to existing browser via CDP
  --save FILE       Save output to file (baseline)
  --diff FILE       Compare with saved baseline
  --problems        Show ONLY detected problems
  --compare         Side-by-side mobile vs desktop
```

## How It Works

1. Launches headless Chromium via Playwright (or connects to existing browser via CDP)
2. Navigates to URL, waits for render
3. Runs `page.evaluate()` — walks DOM, extracts `getBoundingClientRect()` + `getComputedStyle()` for all visible elements
4. Formats compact text tree with smart features:
   - CSS-in-JS class names (css-xxx, r-xxx) auto-filtered
   - Wrapper divs with no styles collapsed
   - Repeated siblings collapsed (`...x5 more div.card`)
   - Text content, aria-label, placeholder extracted for readable selectors

## License

MIT
