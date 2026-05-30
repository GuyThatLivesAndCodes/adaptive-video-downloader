# adaptive-video-downloader

Professional video downloader for Chrome and Firefox. Clean UI. Works on almost any site.

**Download videos from:**
- HLS streams (encrypted & unencrypted)
- DASH adaptive streams
- Direct MP4, WebM, and other formats
- Token-protected CDN segments
- Encrypted video platforms

Key features:
- Modern, intuitive interface that's never confusing
- Automatic video detection as you browse
- Encryption handling (AES-128 CBC/GCM)
- Adaptive quality selection for DASH
- Parallel downloads with smart retry logic
- MP4 conversion via ffmpeg.wasm (optional)
- Works even if you close the popup

---

## How it works

1. **Automatic Detection** — background script monitors all network traffic and recognizes:
   - **HLS streams** via numbered segments (`seg-12`, `segment_12`, etc.)
   - **DASH manifests** (.mpd files with adaptive representations)
   - **Encrypted streams** (AES-128 CBC/GCM detection via manifest headers)
   - **Direct files** (MP4, WebM, etc. by extension or Content-Type)
   
   Streams are automatically deduplicated—URLs differing only in index converge to a single template. The freshest auth tokens are preserved for segment requests.

2. **UI & Selection** — Click the toolbar icon to see:
   - Segment streams dropdown (HLS/DASH/Encrypted)
   - Direct video files below
   - Quality selector for DASH with bandwidth/size estimates
   - "Test stream" validates access before downloading
   
3. **Smart Download** — Select quality and speed (Balanced/Fast/Aggressive):
   - Parallel segment fetching (6/12/24 concurrent, configurable)
   - Automatic encryption handling (decrypts on-the-fly)
   - Token refresh on expiration (automatic manifest re-fetch)
   - Segment retry with exponential backoff (up to 3 attempts)
   - Live progress tracking in popup
   - **Works even after closing popup** — download continues in background

   Files are merged efficiently:
   - HLS: byte concatenation into `.ts`
   - DASH: proper frame-aligned merging
   - All segments validated before merge

4. **Convert to MP4 (optional)** — After download completes:
   - Press "Convert to MP4" to remux via ffmpeg.wasm
   - Stream copy (no re-encoding) — fast, lossless
   - Produces standard progressive MP4 with fixed timestamps
   - Works with any codec (H.264, HEVC, AAC, AC-3, Opus, etc.)

5. **Advanced** — Content script intercepts:
   - Blob URLs (for Vidplay-like players)
   - Manifest updates (for token refresh)
   - Auth tokens (automatic extraction from storage/cookies)

### Example segment URLs

```
http://…cloudwindow-route.com/…/0bhusoiktttu_,h,n,l,.urlset/seg-21-f2-v1-a1.ts?t=…
https://…cloudwindow-route.com/…/0bhusoiktttu_,h,n,l,.urlset/seg-22-f2-v1-a1.ts?t=…
```

Only the number right after `seg-` changes between segments, so the downloader
rewrites it from `1` upward while keeping the rest of the URL (including the
token) intact.

---

## Install (unpacked / temporary)

Build the packages first (see below), or load straight from source.

**Firefox** (Manifest V2)
1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `manifest.firefox.json` (or any file in a
   built `dist/firefox/` folder).

**Chrome / Edge** (Manifest V3)
1. `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the built `dist/chrome/` folder.

> Firefox uses Manifest V2 so that the `<all_urls>` host permission (needed to
> observe network traffic) is granted at install time. Chrome uses Manifest V3.
> Both share the exact same `src/` code.

---

## Build

```bash
npm run build      # or: bash build.sh
```

This writes to `dist/`:

- `dist/chrome/` and `dist/firefox/` — unpacked extensions
- `dist/artifacts/adaptive-video-downloader-chrome-v<version>.zip`
- `dist/artifacts/adaptive-video-downloader-firefox-v<version>.zip`
- `dist/artifacts/adaptive-video-downloader-firefox-v<version>.xpi`

Icons are generated (no dependencies) with `npm run icons`.

### Continuous builds

`.github/workflows/build.yml` runs on **every push** (and on PRs /
manual dispatch). It builds both packages and uploads them as workflow
artifacts (`adaptive-video-downloader-chrome` and
`-firefox`), downloadable from the run's **Summary** page.

---

## Project layout

```
src/
  popup.html/.css/.js     Modern UI: detect streams, select quality, live download progress
  background.js           Network monitoring, tab stream store, download routing
  engine.js               Core download engine: HLS segments, merging, MP4 conversion
  offscreen.html/.js      Chrome (MV3): persistent download context
  content-script.js       Page context interception: blobs, manifests, tokens
  
  manifest-parser.js      Unified HLS/DASH/Smooth Streaming parser
  crypto-engine.js        AES-128 encryption/decryption with key caching
  segment-manager.js      Batch download coordination, retry logic, quality selection
  download-coordinator.js Bridge layer: manifest → segments → merge pipeline
  
  vendor/ffmpeg/          ffmpeg.wasm 0.12 (32 MB): `-c copy` MP4 remux
  icons/                  Generated PNGs
  
manifest.chrome.json      Manifest V3 with content script, offscreen
manifest.firefox.json     Manifest V2 with content script
build.sh                  Builds both Chrome + Firefox packages
```

---

## Site support

**Works well:**
- HLS streams (generic, token-protected, encrypted)
- DASH streams (unencrypted adaptive content)
- Vimeo, Wistia (encrypted HLS)
- TikTok, Instagram (direct MP4)
- Generic CDN segments with rotating tokens
- Vidplay, similar protected platforms (with content script interception)

**Intentionally not supported** (shown with clear explanation):
- **YouTube** — Requires obfuscated player code; against Terms of Service
- **DRM-protected** (Netflix, Disney+, Prime Video, etc.) — Content is encrypted with secure keys; won't be bypassed
  
**May require setup:**
- Some pages with strict CORS policies may need CORS headers from your browser
- Very old/custom streaming protocols may not auto-detect

**Notes:**
- HLS encryption (AES-128-CBC) is automatically handled
- DASH streams auto-select best quality by default
- Token expiration is detected and auto-refreshed for most sites
- Download list is in `src/popup.js` (`UNSUPPORTED_SITES`)

## Notes & limitations

- The download runs in the background and saves itself via the **Downloads API**
  (so it lands in your default downloads folder without a Save dialog). It keeps
  going if you close the popup; it only stops if you press **Stop**, start a
  different download, or the browser shuts the extension down. One download runs
  at a time — starting another replaces the current one.
- Segments are merged in memory, so extremely long videos (toward the 3000-cap)
  can use a lot of RAM. MP4 conversion additionally holds the input and output
  in ffmpeg's in-memory filesystem alongside the ~32 MB core.
- **MP4 conversion is a stream copy** (`-c copy`) — no transcoding, so it's
  lossless and keeps whatever codec the source uses. The output is a standard
  progressive MP4 with `+faststart`. (If a stream's codec genuinely can't sit in
  an MP4 container, ffmpeg errors and the `.ts` remains saved.)
- The bundled ffmpeg core is committed to the repo so the build works as-is. To
  refresh it: `npm install` then `npm run vendor`.
- Works for token-signed CDN segments that don't require the original page's
  `Referer`/`Origin`.
- This is a general media tool. Only download content you have the right to.
