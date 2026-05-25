# adaptive-video-downloader

The most adaptive, easy-to-use video downloader that works on almost any site.
With a slick UI and advanced innersystems, this plugin beats competitors at
style and speed.

It detects **adaptive (HLS) `.ts` video segments** as you browse, then downloads
every segment of a video and merges them back into a single playable file.

---

## How it works

1. **Logging** — once installed, the background script watches network traffic
   on every tab (`webRequest`). Each segment URL containing `seg-<number>` is
   recorded per tab. Only the freshest URL per stream is kept (the signed token
   is shared across all segments of a video), along with the highest segment
   number seen.
2. **Scan** — click the toolbar icon. The popup asks the background script for
   the segment URLs captured on the current tab and lists each detected video.
3. **Random test** — the popup immediately fires one request at a *random*
   segment number on the captured URL (e.g. `seg-21` → `seg-1847`). Because the
   token is not tied to a single segment, a successful response confirms the
   stream can be fetched on demand.
4. **Download** — press **Download video**. A dedicated progress tab opens and
   fetches `seg-1 … seg-3000`:
   - each segment is tried up to **3 times** (1 try + 2 retries);
   - the **first segment that still fails is treated as the end of the video**;
   - all segments before it are concatenated (MPEG-TS segments merge by simple
     byte concatenation) into one `.ts` file and saved to your Downloads.

   Downloading runs in a real tab (not the popup) so it keeps going even if you
   click away, and a **Stop & save** button lets you keep a partial video.
   Tick **Hyper mode** in the popup to fetch many segments in parallel (24 at a
   time instead of 6) for a large speedup on CDNs that allow it; the preference
   is remembered.
5. **Convert to MP4 (optional)** — once the `.ts` is saved, press **Convert to
   MP4**. The bundled [mux.js](https://github.com/videojs/mux.js) losslessly
   remuxes the MPEG-TS into an `.mp4` (container change only — **no
   re-encoding**, so it's fast and quality is identical). The result plays in
   browsers, VLC, QuickTime, and mobile players. Works for standard H.264 video
   + AAC audio HLS streams.

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
  background.js     network logging + per-tab segment store (SW / event page)
  popup.html/.css/.js   scan, random test, download button
  progress.html/.css/.js  fetch seg-1..3000, retry, merge, save, convert
  vendor/mux-mp4.min.js   mux.js — MPEG-TS → MP4 remuxer (Apache-2.0)
  icons/            generated PNGs
manifest.chrome.json   Manifest V3 (Chrome)
manifest.firefox.json  Manifest V2 (Firefox)
tools/make-icons.mjs   PNG icon generator
build.sh               packages both browsers
```

---

## Notes & limitations

- Segments are merged in memory, so extremely long videos (toward the 3000-cap)
  can use a lot of RAM. MP4 conversion holds both the source and output in
  memory while remuxing.
- **MP4 output is a fragmented MP4** (fMP4). It plays everywhere modern; a few
  legacy desktop tools prefer progressive MP4. Only H.264/AAC streams can be
  remuxed — other codecs (e.g. HEVC) keep the `.ts`.
- To refresh the bundled remuxer: `npm install` then `npm run vendor`.
- Works for token-signed CDN segments that don't require the original page's
  `Referer`/`Origin`.
- This is a general media tool. Only download content you have the right to.
