# Vizor CLI

**The browser tool built for AI agents.** Navigate, click, analyze layout, detect bugs, take optimized screenshots — all from one CLI, at a fraction of the token cost of alternatives.

```bash
vizor https://myapp.com --problems          # find layout bugs in 503 tokens
vizor https://myapp.com --ss /tmp/out.webp  # full-page WebP screenshot
vizor https://myapp.com \
  --fill "#email" "user@test.com" \
  --click "button[type=submit]" \
  --assert-url "/dashboard" \
  --problems                                # login + analyze in one command
vizor https://myapp.com \
  --flow tests/login.flow \
  --record-video /tmp/session.mp4           # record test session as video
```

### Demo videos (stripe.com)

Idle frames are automatically removed — a 30s test with 20s of waiting produces a compact video of actual changes only.

| Viewport | Video | Size |
|----------|-------|------|
| Desktop 1440px | [demo-stripe-desktop.mp4](assets/demo-stripe-desktop.mp4) | 116 KB |
| Mobile 430px | [demo-stripe-mobile.mp4](assets/demo-stripe-mobile.mp4) | 44 KB |
| Click interaction (vercel.com) | [demo-vercel.mp4](assets/demo-vercel.mp4) | 166 KB |

---

## Install

```bash
# One-liner — self-contained, no config needed
curl -fsSL https://raw.githubusercontent.com/serter2069/vizor/main/vizor.js -o vizor && chmod +x vizor

# Or via npm
npm install -g vizor-cli
```

First run bootstraps its own isolated Playwright + Chromium into `~/.vizor` (~165MB, one-time). Zero config.

---

## What It Does

Vizor combines two things other tools separate:

**1. Browser automation** — click, fill, scroll, drag, upload, multi-tab, network interception, cookies  
**2. Layout analysis** — extract exact dimensions, colors, spacing, detect UX problems, compare viewports

No other CLI tool does both. You run one command, get automation + structured layout data.

---

## Analysis Modes

| Flag | Tokens | What you get |
|------|--------|-------------|
| `--problems` | **~500** | Auto-detected list of layout/UX bugs |
| `--describe` | **~1,100** | Design summary: palette, fonts, layout structure |
| _(default)_ | **~2,000** | Full layout tree: dimensions, colors, spacing, position |
| `--aria` | ~2,000 | ARIA tree: roles, labels, hierarchy |
| `--compare` | ~4,000 | Mobile (430×932) vs desktop (1440×900) side-by-side |
| `--sweep` | ~5,000 | 5 viewports at once: 320, 430, 768, 1024, 1440px |
| `--sweep-viewports W1xH1,...` | varies | Custom viewport list |
| `--hover SEL` | ~300 | CSS style delta on hover |
| `--diff FILE` | ~500 | Changed elements vs saved baseline |

### Problem Detection (11 types)

```
vizor https://linear.app --problems
```

```
PROBLEMS: https://linear.app (viewport: 430×932)
────────────────────────────────────────────────────
⚠️  overflow:        div.Marquee 836×28 — wider than 430px viewport
⚠️  hidden-clip:     div.Frame_background 430×400 — content clipped
⚠️  tiny-tap:        a "Skip to content" 430×32 — min 44×44px for touch
⚠️  low-contrast:    a "Get started" — 1.00:1 ratio, need 4.5 (WCAG AA)
⚠️  no-label:        a.Logos_logosLink — no text, aria-label, or title
⚠️  spacing:         div.LayoutContent — inconsistent margins: 33,39,47,79,7px
⚠️  z-conflict:      header z:100 vs a.SkipNav z:5000 — may overlap
Total: 16 problems
```

| Problem | What it finds |
|---------|--------------|
| `overflow` | Element wider than viewport without scrollable parent |
| `hidden-clip` | `overflow:hidden` clipping visible content |
| `tiny-tap` | Interactive element smaller than 44×44px (touch target) |
| `tiny-text` | Font size < 12px |
| `low-contrast` | Text contrast below WCAG AA (4.5:1) |
| `offscreen` | Element fully outside viewport |
| `no-label` | Button/link with no accessible text |
| `clickable-no-role` | `div` with onclick but no `role="button"` |
| `ghost` | Large invisible element (opacity:0) blocking clicks |
| `spacing` | Inconsistent margins between siblings |
| `z-conflict` | Fixed/sticky elements with overlapping z-index |

---

## Interactive Actions

All actions run in sequence before analysis. Combine freely.

### Navigation & Input

```bash
vizor https://app.com \
  --fill "#email" "user@example.com" \
  --fill "#password" "secret" \
  --click "button[type=submit]" \
  --wait-for ".dashboard" \
  --problems
```

| Flag | What it does |
|------|-------------|
| `--click SEL` | Click element |
| `--fill SEL VAL` | Clear and fill input |
| `--type SEL VAL` | Type character by character (React inputs) |
| `--press KEY` | Keyboard: `Enter`, `Tab`, `Escape`, `ArrowDown`, … |
| `--goto URL` | Navigate to URL mid-flow |
| `--scroll up\|down\|top\|bottom\|SEL [px]` | Scroll page or element into view |
| `--select SEL VALUE` | Select dropdown option |
| `--drag SOURCE TARGET` | Drag element and drop onto target |
| `--upload SEL FILE...` | Set files on `<input type="file">` |
| `--hover SEL` | Hover element (also works as analysis mode) |
| `--wait-for SEL` | Wait until selector visible (10s max) |
| `--wait-gone SEL` | Wait until selector hidden/removed (10s max) |
| `--wait-ms N` | Sleep N milliseconds |

### Assertions

```bash
vizor https://app.com \
  --click ".toggle" \
  --assert-visible ".dropdown" \
  --assert-enabled "button[type=submit]" \
  --assert-text ".badge" "3"
```

| Flag | What it does |
|------|-------------|
| `--assert-exists SEL` | Fail if selector not found |
| `--assert-text SEL TEXT` | Fail if element text doesn't contain TEXT |
| `--assert-url TEXT` | Fail if current URL doesn't contain TEXT |
| `--assert-visible SEL` | Fail if element not visible |
| `--assert-enabled SEL` | Fail if element disabled |
| `--assert-checked SEL` | Fail if checkbox not checked |

### Queries

| Flag | What it does |
|------|-------------|
| `--get SEL` | Print element text in action log |
| `--get-attr SEL NAME` | Print attribute value in action log |

### Multi-Tab

```bash
vizor https://app.com \
  --new-tab https://app.com/dashboard \
  --assert-url "/dashboard" \
  --switch-tab 0 \
  --problems
```

| Flag | What it does |
|------|-------------|
| `--new-tab URL` | Open URL in new tab (becomes active) |
| `--new-tab-blank` | Open blank tab |
| `--switch-tab N` | Switch tab by index (0 = first) |
| `--close-tab` | Close active tab |

---

## Screenshots & Visual Regression

### Optimized Screenshots

```bash
vizor https://app.com --ss /tmp/out.webp              # mobile, full page, WebP q55
vizor https://app.com --ss /tmp/out.webp --desktop    # desktop 1440px
vizor https://app.com --ss /tmp/out.webp --viewport 768x1024

vizor https://app.com --screenshot /tmp/out.jpg       # JPEG q70, viewport only
vizor https://app.com --full-screenshot /tmp/out.jpg  # JPEG q70, full page
vizor https://app.com --screenshot /tmp/out.webp \
  --screenshot-quality 40 \
  --screenshot-width 800                              # custom quality + resize
```

**File sizes on the same page (linear.app, mobile):**

| Format | Size | Notes |
|--------|------|-------|
| PNG | 103 KB | default Playwright output |
| JPEG q70 | 32 KB | native, no extra deps |
| **WebP q55** | **17 KB** | 6× smaller, sharp auto-installed |
| WebP full-page | 95 KB | entire 430×6,530px page |

### Pixel Regression

```bash
# First run: saves baseline automatically
vizor https://app.com --screenshot-diff /tmp/baseline.png

# After deploy: compare vs baseline (fail if >0.5% pixels changed)
vizor https://app.com --screenshot-diff /tmp/baseline.png

# Custom threshold
vizor https://app.com --screenshot-diff /tmp/baseline.png 2.0

# Output on pass:  ✓  screenshot-diff  0.00% diff (0 px) — OK
# Output on fail:  ✗  screenshot-diff  72.59% exceeds threshold 0.5%
```

---

## Mosaic — all screens in one image

Screenshot every screen of an app or site into a single labeled grid — ready to send to an AI for visual review.

```bash
# From metro-map (auto-discovers all app screens)
vizor mosaic --metro http://localhost:8090 --app-url http://localhost:8081 --mobile
vizor mosaic --metro http://localhost:8090 --app-url http://localhost:8081 --desktop --group client

# From a text file (one URL per line, # comments allowed)
vizor mosaic --urls-file screens.txt --mobile --out review.webp

# Direct URLs
vizor mosaic https://stripe.com https://stripe.com/pricing https://stripe.com/docs --desktop
```

**screens.txt format:**
```
# My app screens
http://localhost:8081
http://localhost:8081/auth/email
http://localhost:8081/specialists
http://localhost:8081/requests
```

| Flag | Default | What it does |
|------|---------|-------------|
| `URLs...` | — | Direct URLs to screenshot |
| `--urls-file FILE` | — | Text file, one URL per line (`#` comments ok) |
| `--metro URL` | — | Fetch screen list from metro-map API |
| `--app-url URL` | — | Base URL for metro-map routes |
| `--group GROUP` | — | Filter metro screens by group |
| `--mobile` | ✅ | 430×932, 3 columns |
| `--desktop` | — | 1440×900, 2 columns |
| `--out FILE` | `mosaic-DATE-viewport.webp` | Output file |
| `--quality N` | `65` | WebP quality 1–100 |
| `--wait N` | `2500` | Wait ms per page |
| `--concurrency N` | `4` | Parallel screenshots |
| `--skip PATTERN` | — | Skip URLs containing pattern |

**Real-world sizes:**

| Screens | Viewport | Output |
|---------|----------|--------|
| 6 screens | mobile 430px | **110 KB** |
| 7 screens | desktop 1440px | **74 KB** |

Each screenshot is full-page (scrolled), resized to column width, labeled with the route path. Requires `sharp` (auto-installed in `~/.vizor`).

---

## Video Recording

Record any session — headless, automated, CI-friendly. Uses Playwright's built-in recording, re-encoded via ffmpeg with idle-frame removal.

```bash
# Basic — records full session, saves as mp4
vizor https://app.com \
  --flow tests/login.flow \
  --record-video /tmp/session.mp4

# With skeleton-aware waiting (no hardcoded delays)
vizor https://app.com \
  --flow tests/login.flow \
  --wait-gone '[data-testid="skeleton"]' \
  --record-video /tmp/session.mp4

# Save as WebM (no ffmpeg required)
vizor https://app.com --flow tests/flow.flow --record-video /tmp/session.webm

# Custom fps and quality
vizor https://app.com --flow tests/flow.flow \
  --record-video /tmp/session.mp4 \
  --video-fps 5 \
  --video-quality 35
```

| Flag | Default | What it does |
|------|---------|-------------|
| `--record-video FILE` | — | Save session to FILE (.mp4 via ffmpeg, .webm fallback) |
| `--video-fps N` | `2` | Frames per second for mp4 output |
| `--video-quality N` | `40` | ffmpeg CRF (1–51, lower = better quality) |

**How idle-frame removal works:** ffmpeg `mpdecimate` filter strips consecutive near-identical frames before encoding. A 30-second test with 20 seconds of spinner/skeleton waiting becomes a compact video showing only the actual state changes.

**File sizes (real-world flows):**

| Content | Duration | Raw WebM | mp4 (2fps, CRF 40) |
|---------|----------|----------|--------------------|
| Static page | 3s | 79 KB | **5 KB** |
| Click + navigate | ~2s | — | **7 KB** |
| Full auth flow (6 screens) | ~30s recorded | — | **35 KB** |

> Requires ffmpeg for `.mp4` output (`brew install ffmpeg`). Falls back to `.webm` automatically if ffmpeg is not found.

---

## Network Interception

```bash
# Capture all API calls
vizor https://app.com --net-capture --problems

# Mock an endpoint with fixture data
vizor https://app.com \
  --net-stub "**/api/user" fixtures/user.json \
  --problems

# Test offline/error state
vizor https://app.com --net-block "**/api/**" --problems
```

```
NET CAPTURE: https://app.com
────────────────────────────────────────────────────────────────
  METHOD  ST    SIZE     MS     URL
  POST    200   0.4kb    45ms   /api/auth/login
  GET     200   12.3kb   120ms  /api/user/profile
  GET     404   0.1kb    12ms   /api/missing-endpoint        !
────────────────────────────────────────────────────────────────
  3 requests  |  1 error
```

---

## Console & Session

```bash
# Catch JS errors during page load or after actions
vizor https://app.com --console-errors --problems

# Persist login across runs
vizor https://app.com \
  --fill "#email" "user@example.com" \
  --click "button[type=submit]" \
  --cookies-save /tmp/session.json

vizor https://app.com/dashboard \
  --cookies-load /tmp/session.json \
  --problems
```

---

## Flow Files

Run a reusable sequence from a file:

```bash
vizor https://app.com --flow tests/login.json --problems
```

**JSON format:**
```json
[
  { "fill": "#email", "value": "user@example.com" },
  { "fill": "#password", "value": "secret" },
  { "click": "button[type=submit]" },
  { "wait-for": ".dashboard" },
  { "assert-url": "/dashboard" },
  { "screenshot": "/tmp/dashboard.webp" }
]
```

**Line format:**
```
fill #email user@example.com
fill #password secret
click button[type=submit]
wait-for .dashboard
assert-url /dashboard
screenshot /tmp/result.jpg
scroll bottom
screenshot-diff /tmp/baseline.png
```

---

## Setup Options

```
--viewport WxH            Viewport size (default: 430x932 — mobile)
--desktop                 Shortcut for --viewport 1440x900
--depth N                 Tree depth (default: 8)
--wait N                  Initial render wait in ms (default: 2000)
--no-warnings             Hide warning markers in tree
--headed                  Show browser window (headless by default)
--slow-mo N               Slow down actions by N ms (useful with --headed)
--cdp PORT                Connect to existing browser via CDP
--save FILE               Save analysis output to file
--actions-log             Always print action log (default: only on failure)
--screenshot-quality N    JPEG/WebP quality 1-100 (JPEG: 70, WebP: 55)
--screenshot-width N      Resize screenshot to max N px wide
```

---

---

# vs Playwright MCP, Playwright CLI, agent-browser

There are three popular browser tools used by AI agents today. Here's how they compare — with real benchmark data.

---

## The Benchmark

**Same site. Same task: find layout problems on [linear.app](https://linear.app)**

![Token comparison chart](assets/token-chart.png)

| Tool | Output | Tokens | Dimensions? | Colors? | Problems list? |
|------|--------|--------|------------|---------|---------------|
| **vizor `--problems`** | text | **503** | — | — | ✅ auto |
| **vizor `--describe`** | text | **1,146** | ✅ px | ✅ hex | — |
| **vizor tree** | text | **2,185** | ✅ px | ✅ hex | — |
| Screenshot (vision) | image | ~1,100 | ❌ | ❌ | ❌ |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) ARIA | text | 4,332 | ❌ | ❌ | ❌ |
| [agent-browser](https://agent-browser.dev) snapshot | text | 5,038 | ❌ | ❌ | ❌ |

> Benchmark measured April 2026.

---

## Tool-by-Tool Breakdown

### [Playwright MCP](https://github.com/microsoft/playwright-mcp) — by Microsoft

MCP server + CLI (`npx @playwright/mcp`) that connects Claude/AI assistants to a browser. Has two modes: ARIA-based (default) and `--vision` (screenshot-based).

```bash
npx @playwright/mcp --headed         # headed by default
npx @playwright/mcp --vision         # screenshot-based mode
npx @playwright/mcp --headless       # headless
```

**Strengths:**
- Native MCP integration with Claude — best for conversational browser control
- Headed by default — user sees every click in real time
- `--vision` mode: AI navigates by screenshots instead of ARIA tree
- Video, traces, PDF, geo emulation, offline mode
- Full Playwright API surface

**Limitations:**
- ARIA mode: no layout dimensions, no colors, no problem detection
- Vision mode: high token cost, no structured data
- Not optimized for automated batch runs
- Screenshots PNG only, no WebP/JPEG optimization

**Best for:** Pair-review sessions inside Claude where the user watches the browser. Vision mode for sites where ARIA is broken.

---

### [agent-browser](https://agent-browser.dev) — standalone CLI

Polished CLI designed for AI agents. Rich command set, good ergonomics.

**Strengths:**
- Clean API: `agent-browser open`, `click`, `snapshot`, `screenshot`
- Pixel regression: `diff screenshot --baseline`
- Geo emulation, custom headers, offline mode
- PDF export, video recording
- `find` by role/label/placeholder (semantic locators)

**Limitations:**
- Snapshot = ARIA tree only (4,332–5,038 tokens) — no layout data
- Screenshot = PNG only, no WebP/JPEG optimization
- No layout analysis, no problem detection
- No multi-viewport comparison

**Best for:** Scripted browser automation where you don't need layout analysis and want a polished, dedicated CLI.

---

### Vizor — this tool

**Strengths:**
- Layout analysis + automation in one tool
- `--problems`: 11 types of UX bugs auto-detected
- `--describe`: palette, typography, layout structure
- `--compare` / `--sweep`: multi-viewport analysis
- Optimized screenshots: WebP q55 = 6× smaller than PNG
- Pixel regression: `--screenshot-diff baseline.png`
- Drag & drop, file upload, cookies, console capture
- Full flow automation: click, fill, scroll, assert
- Cheaper: 503–2,185 tokens vs 4,332–5,038

**Limitations:**
- No headed mode (always headless)
- No PDF export
- No geo/offline emulation (yet)

**Best for:** AI agents that need to both automate AND analyze the UI — finding layout bugs, checking responsive behavior, running visual regression after deploys.

---

## Feature Matrix

| Feature | vizor | [Playwright MCP](https://github.com/microsoft/playwright-mcp) | [agent-browser](https://agent-browser.dev) |
|---------|-------|---------------|--------------|
| Click, fill, type | ✅ | ✅ | ✅ |
| Scroll, select, drag | ✅ | ✅ | ✅ |
| File upload | ✅ | ✅ | ✅ |
| Multi-tab | ✅ | ✅ | ✅ |
| Assertions | ✅ | ✅ | ✅ |
| Network intercept | ✅ | ✅ | ✅ |
| Cookies / session | ✅ | ✅ | ✅ |
| Console capture | ✅ | ✅ | ✅ |
| **Layout tree (px, colors)** | ✅ | ❌ | ❌ |
| **Problem detection (11 types)** | ✅ | ❌ | ❌ |
| **Design summary (palette, fonts)** | ✅ | ❌ | ❌ |
| **Multi-viewport sweep** | ✅ | ❌ | ❌ |
| **WebP/JPEG optimized screenshots** | ✅ | ❌ | ❌ |
| Pixel regression | ✅ | ❌ | ✅ |
| Headed mode (user sees browser) | ✅ `--headed` | ✅ default | ✅ |
| Video recording | ✅ | ✅ | ✅ |
| PDF export | ❌ | ✅ | ✅ |
| Geo / offline emulation | ❌ | ✅ | ✅ |
| Standalone CLI | ✅ | ✅ `npx @playwright/mcp` | ✅ |
| Token cost (layout task) | **503–2,185** | 4,332 | 5,038 |

---

## When to Use What

| Situation | Best tool |
|-----------|----------|
| AI agent finding layout bugs | **vizor** |
| AI agent checking responsive design | **vizor** |
| Visual regression after deploy | **vizor** |
| Scripted automation (forms, clicks, flows) | **vizor** |
| Pair-session, user watches browser | **vizor `--headed`** |
| Need headed browser | **vizor `--headed`** |
| Record test session as video | **vizor** |
| Need PDF export | Playwright MCP or agent-browser |
| Need geo / offline emulation | Playwright MCP or agent-browser |

---

## License

MIT
