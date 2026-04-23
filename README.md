# Vizor CLI

Lightweight layout analysis tool for AI agents. Extracts page structure, computed styles, and detects layout problems — **without screenshots**.

A single page scan costs ~200 tokens vs ~100K+ tokens for a screenshot. **500x cheaper** context for AI-powered UI review.

## Install

```bash
# Self-contained: downloads playwright + chromium on first run (~165MB, one-time)
curl -fsSL https://raw.githubusercontent.com/serter2069/vizor/main/vizor.js -o vizor && chmod +x vizor

# Or via npm
npm install -g vizor-cli
```

No configuration needed. First run bootstraps its own isolated Playwright runtime into `~/.vizor`.

## Quick Start

```bash
vizor http://localhost:3000                    # layout tree, mobile viewport
vizor http://localhost:3000 --problems         # problems only
vizor http://localhost:3000 --describe         # design summary (palette, fonts, layout)
vizor http://localhost:3000 --compare          # mobile vs desktop side-by-side
```

## Analysis Modes

| Flag | What it does |
|------|-------------|
| _(default)_ | Full layout tree — dimensions, colors, spacing, position |
| `--problems` | Only detected layout/UX problems |
| `--describe` | Design summary: palette, typography, layout structure |
| `--aria` | ARIA tree (roles, labels, hierarchy) |
| `--hover SEL` | Style delta when hovering a selector |
| `--compare` | Mobile (430×932) vs desktop (1440×900) side-by-side |
| `--sweep` | Analyze across 5 viewports: 320×640, 430×932, 768×1024, 1024×768, 1440×900 |
| `--sweep-viewports W1xH1,...` | Sweep with a custom viewport list |
| `--diff FILE` | Compare current tree against a saved baseline |

```bash
# Standard sweep — 5 breakpoints
vizor http://localhost:3000 --sweep

# Custom viewports
vizor http://localhost:3000 --sweep-viewports 375x812,768x1024,1920x1080
```

## Problem Detection (10 types)

| Problem | What it finds |
|---------|--------------|
| `overflow` | Element wider than viewport without scrollable parent |
| `hidden-clip` | `overflow:hidden` clips visible content |
| `tiny-tap` | Interactive element smaller than 44×44px (touch target) |
| `tiny-text` | Font size < 12px |
| `offscreen` | Element completely outside viewport |
| `no-label` | Button/link with no text or aria-label |
| `clickable-no-role` | `div` with onclick but no `role="button"` |
| `ghost` | Large invisible element (opacity:0) covering content |
| `spacing` | Inconsistent margins between siblings |
| `z-conflict` | Fixed/sticky elements with overlapping z-index |

## Interactive Actions

Actions run before analysis, in order. Combine freely.

```bash
# Click a button, wait for navigation, analyze result
vizor http://localhost:3000 --click "button[type=submit]" --wait-for ".dashboard" --problems

# Fill a form and assert the result
vizor http://localhost:3000 \
  --fill "#email" "user@example.com" \
  --fill "#password" "secret" \
  --click "button[type=submit]" \
  --assert-url "/dashboard"

# Screenshot mid-flow
vizor http://localhost:3000 --click ".menu" --screenshot /tmp/menu-open.png --problems
```

| Action | Syntax |
|--------|--------|
| `--click SEL` | Click element |
| `--fill SEL VAL` | Clear and fill input |
| `--type SEL VAL` | Type into input (no clear) |
| `--press KEY` | Keyboard key: `Enter`, `Tab`, `ArrowDown`, … |
| `--goto URL` | Navigate mid-flow |
| `--wait-for SEL` | Wait until selector visible (10s max) |
| `--wait-ms N` | Sleep N milliseconds |
| `--screenshot FILE` | Save PNG to file |
| `--assert-exists SEL` | Fail if selector missing |
| `--assert-text SEL TEXT` | Fail if element text lacks TEXT |
| `--assert-url TEXT` | Fail if current URL lacks TEXT |
| `--flow FILE` | Load actions from JSON or line-based file |
| `--actions-log` | Always print action log (default: only on failure) |

## Multi-Tab

Open and switch between tabs as part of an action flow.

```bash
# Open a second tab, analyze it
vizor http://app.com --new-tab http://app.com/dashboard --problems

# Open tab, switch back to first, compare
vizor http://app.com \
  --new-tab http://app.com/settings \
  --switch-tab 0 \
  --problems
```

| Action | Syntax |
|--------|--------|
| `--new-tab URL` | Open URL in a new tab (becomes active) |
| `--new-tab-blank` | Open blank tab |
| `--switch-tab N` | Switch to tab by index (0 = first opened) |
| `--close-tab` | Close active tab, switch to previous |

Multi-tab actions also work inside `--flow` files:
```json
[
  { "goto": "http://app.com" },
  { "new-tab": "http://app.com/checkout" },
  { "assert-url": "/checkout" },
  { "switch-tab": 0 }
]
```

## Network Interception

```bash
# Capture all XHR/fetch requests made during page load
vizor http://localhost:3000 --net-capture --problems

# Stub an API endpoint with a local fixture
vizor http://localhost:3000 --net-stub "**/api/user" fixtures/user.json --problems

# Block all API calls (test offline/error state)
vizor http://localhost:3000 --net-block "**/api/**" --problems
```

`--net-capture` output:
```
NET CAPTURE: http://localhost:3000
────────────────────────────────────────────────────────────────
  METHOD  ST    SIZE     MS     URL
  POST    200   0.4kb    45ms   /api/auth/login
  GET     200   12.3kb   120ms  /api/user/profile
  GET     404   0.1kb    12ms   /api/missing-endpoint        !
────────────────────────────────────────────────────────────────
  3 requests  |  1 error
```

| Flag | What it does |
|------|-------------|
| `--net-capture` | Collect XHR/fetch, print table after analysis |
| `--net-stub PATTERN FILE` | Fulfill matching requests with JSON from FILE |
| `--net-block PATTERN` | Abort matching requests |

Multiple `--net-stub` and `--net-block` flags can be combined.

## Flow Files

Load a sequence of actions from a file with `--flow FILE`.

**JSON format:**
```json
[
  { "goto": "http://localhost:3000/login" },
  { "fill": "#email", "value": "user@example.com" },
  { "fill": "#password", "value": "secret" },
  { "click": "button[type=submit]" },
  { "wait-for": ".dashboard" },
  { "assert-url": "/dashboard" }
]
```

**Line-based format:**
```
goto http://localhost:3000/login
fill #email user@example.com
fill #password secret
click button[type=submit]
wait-for .dashboard
assert-url /dashboard
screenshot /tmp/result.png
```

## Output Example

```
PAGE: http://localhost:3000 (viewport: 430x932)
────────────────────────────────────────────────────────────────
[body] 430x932
  [header.navbar] 430x56 flex-row bg:#1a1a2e jc:between ai:center sticky(0,_) z:100
    [div.logo "MyApp"] 99x28
    [button "Login"] 76x44 bg:#e94560 r:8
  [main] 430x1200 flex-col
    [section.hero] 430x300 flex-col ai:center p:40,16
      [h1 "Welcome"] 398x32 font:28/700 #ffffff
      [p "Browse our products"] 398x18 font:16 #a0a0b0
    [div.cards-grid] 398x424 grid-2col gap:12
      [div.card] 193x214 bg:#ffffff r:12
        [div.card-img] 193x120 bg:#dddddd
        [div.card-title "Product Name"] 169x16 font:14/600
        [div.card-price "$299"] 169x18 font:16/700 #e94560
```

## What It Extracts

For each visible element:
- **Selector**: `tag.class "text"` (CSS-in-JS classes auto-filtered)
- **Dimensions**: width × height from `getBoundingClientRect()`
- **Layout**: `flex-row`, `flex-col`, `grid-Ncol`, `scroll-x/y`
- **Alignment**: `jc:center`, `jc:between`, `ai:center`
- **Spacing**: `m:16`, `p:8,16`, `gap:12`, `mx:auto`
- **Visual**: `bg:#hex`, `font:size/weight`, `#color`, `r:8`, `border:1px #hex`, `opacity:0.5`
- **Position**: `fixed(top,left)`, `absolute(top,left)`, `sticky(top,_)`
- **Z-index**: `z:100`

## Setup Options

```
--viewport WxH    Viewport size (default: 430x932)
--desktop         Shortcut for --viewport 1440x900
--depth N         Max tree depth (default: 8)
--no-warnings     Hide warning flags
--wait N          Initial render wait in ms (default: 2000)
--cdp PORT        Connect to existing browser via CDP instead of launching headless
--save FILE       Save analysis output to file
```

## How It Works

1. Launches headless Chromium via Playwright (self-installed into `~/.vizor`)
2. Navigates to URL, runs optional action flow
3. Calls `page.evaluate()` — walks the DOM, reads `getBoundingClientRect()` + `getComputedStyle()` for every visible element
4. Formats a compact text tree with smart cleanup:
   - CSS-in-JS class names (`css-xxx`, `r-xxx`) auto-filtered
   - Unstyled wrapper divs collapsed
   - Repeated siblings collapsed (`… ×5 more div.card`)
   - Text content, `aria-label`, `placeholder` used for readable selectors

## License

MIT
