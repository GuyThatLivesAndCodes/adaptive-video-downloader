# Adaptive Video Downloader

Download almost any video on the web — adaptive HLS and DASH streams, raw
numbered-segment streams, and plain video files — from one glassy, iOS-style
popup. **Auto mode** picks the best source and quality and gets it done in one
tap; **Manual mode** lets you control exactly how each video is downloaded.
Every download lands in a searchable **History**.

Works in **Chrome / Edge** (Manifest V3) and **Firefox** (Manifest V2) from the
same `src/`.

---

## Features

### Two modes

| | **Auto** | **Manual** |
|---|---|---|
| Source | Ranks every detected source and picks the main video (manifests over raw segments, duration-matched to the `<video>` on the page, ads/previews de-ranked) | Pick any detected source, or paste your own link |
| Quality | Highest available | Any variant, plus any alternate audio track |
| Output | MP4 (lossless remux) | Auto · MP4 · Original stream · Audio only (M4A / MP3) |
| Range | Whole video | Trim by time (`1:30`–`4:05`) or by segment number |
| Speed | Adaptive connection count | Adaptive or fixed 1–32 parallel requests, retries, timeout, polite delay |
| Errors | Skips unrecoverable segments | Skip them, or stop at the first gap |
| Headers | Page sent as Referer, cookies on | Custom Referer, cookies on/off |
| Live | Records until you press Stop | Record live, optional time limit |

### Source support

- **HLS** (`.m3u8`) — master + variant playlists, separate audio renditions,
  fMP4 (`EXT-X-MAP`) and MPEG-TS segments, byte-range segments, **AES-128**
  clear-key encryption (decrypted with WebCrypto), and **live recording**.
- **DASH** (`.mpd`) — `SegmentTemplate` (`$Number$` / `$Time$`, with or without
  `SegmentTimeline`), `SegmentList`, and single-file `SegmentBase`; video and
  audio are downloaded separately and muxed.
- **Numbered segment streams** — URLs like `seg-12.ts`, `chunk_12`, `00012.ts`
  are folded into one template; the engine scans forward and detects the end
  (peeking ahead so a single missing segment isn't mistaken for the end).
- **Direct files** (`.mp4`, `.webm`, `.mov`, … or anything served as `video/*`)
  — split into 4 MB ranges and fetched in parallel when the server supports it,
  otherwise streamed with automatic resume after dropped connections.
- **Right-click** any `<video>` or video link → *Download with Adaptive*.

DRM-protected streams (Widevine, FairPlay, PlayReady, SAMPLE-AES) are detected
and refused — the extension never bypasses DRM. YouTube and the major DRM
streaming services show a red “unavailable” view instead of a scan.

### Play safely & pop-up shield

Many video sites hide an invisible layer over the player, so the first click on
“play” opens an ad tab or redirects the page. **Play safely** starts the video
without any real click on the page:

1. pop-up windows are switched off in the page for 30 seconds;
2. invisible layers stacked over the player are disabled (they stop catching
   clicks — the player's own controls are left alone);
3. the player library is asked to play (JW Player, video.js, Flowplayer,
   Clappr), then the `<video>` itself (muted if the browser's autoplay rules
   insist);
4. as a last resort, the player's own play button gets a click that doesn't
   bubble — its handler runs, document-wide ad listeners never see it.

It runs in every frame (embedded players included), then rescans for the stream.

The **pop-up shield** (turned on by Play safely, or by its switch) keeps
protecting the tab: new tabs or windows it opens to *another* site are closed
immediately and focus returns to the video (same-site tabs are allowed), and for
20 seconds after Play safely, a jump of the tab itself to another site is undone.
A header chip shows how much was blocked; the shield switches itself off when
you take the tab to a different site.

Limits: it can't skip ads that play *inside* the video stream, and a redirect
triggered by your own later clicks outside the 20-second window isn't undone
(new ad tabs still are).

### Reliability

- **Adaptive concurrency (AIMD)** — starts polite, adds connections while the
  CDN keeps up, halves on 429/503/timeouts.
- **Retries with exponential backoff + jitter**, honouring `Retry-After`, plus
  a slower second pass over anything that still failed.
- **Referer/Origin rewriting** for the extension's own requests (DNR session
  rule on Chrome, `onBeforeSendHeaders` on Firefox) — fixes most 403s from
  hot-link-protected CDNs.
- **Detection fallback** — the popup also reads the page's own resource log, so
  videos that started before the extension was listening (fresh install,
  update, restored tabs) are still found.
- **Background engine** — downloads run in an offscreen document (Chrome) or
  the background page (Firefox), so closing the popup never stops them. A
  **queue** runs jobs one after another; each can be paused, resumed, stopped
  (keeps what's downloaded) or discarded.
- **Real ffmpeg** (ffmpeg.wasm) for remux/mux/extract — stream copy only, no
  re-encoding; falls back to MKV or separate files rather than failing.

### History

Searchable list grouped by day, with filters (Completed / Partial / Failed),
thumbnails (a frame grabbed from the playing video, or its poster), quality,
format, size and duration. Each entry can **Open** the file, **Show** it in its
folder, jump back to the **page** (also the way to retry a failed one), copy
the page link, or be removed. Detects files that were moved or deleted.

### Settings

Default mode, default format, pop-up shield with Play safely, filename template (`{title} {site} {quality}
{date} {time}`), Downloads subfolder, “ask where to save”, network defaults,
theme (System / Light / Dark), accent colour, completion notifications, and the
video-count badge on the toolbar icon.

---

## Install (unpacked / temporary)

Build first (below), then:

**Chrome / Edge** — `chrome://extensions` → enable *Developer mode* → *Load
unpacked* → select `dist/chrome/`.

**Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary
Add-on…* → pick any file in `dist/firefox/`.

## Build

```bash
npm run build      # or: bash build.sh
```

Writes `dist/chrome/`, `dist/firefox/` and zipped packages (plus a Firefox
`.xpi`) to `dist/artifacts/`. `.github/workflows/build.yml` builds both on every
push and uploads them as workflow artifacts. Icons are generated with
`npm run icons` (no dependencies).

---

## Project layout

```
src/
  shared.js        settings defaults, storage keys, blocked sites, formatting
                   and filename helpers (loaded by every context)
  manifest.js      HLS + DASH parsers, quality/audio description for the popup,
                   and resolution into concrete download tracks for the engine
  engine.js        the download engine: job queue, AIMD limiter, retries,
                   AES-128, init segments, live recording, ranged file download,
                   ffmpeg.wasm remux/mux/extract, saving, history records
  background.js    network detection (manifests, segment templates, files),
                   playlist inspection, badge, engine routing, history,
                   Referer rewriting, notifications, context menu
  offscreen.html/.js   Chrome host page for the engine (survives popup close)
  popup.html/.css/.js  the glass UI: Auto / Manual, active downloads + queue,
                   History, Settings
  vendor/ffmpeg/   ffmpeg.wasm 0.12 (single-threaded core, loaded on demand)
  icons/           generated PNGs
manifest.chrome.json   Manifest V3
manifest.firefox.json  Manifest V2 (engine runs in the background page)
tools/make-icons.mjs   icon generator
build.sh               packages both browsers
```

## Notes & limitations

- Media is assembled in memory (as Blobs, which browsers can page to disk).
  In-browser MP4 conversion is limited to ~900 MB; larger downloads are saved
  in their original container instead.
- Live DASH isn't supported yet (live HLS is).
- Sites that bind media URLs to the page session in other ways (signed cookies
  on a different domain, per-request tokens) may still refuse the download.
- To refresh the bundled ffmpeg core: `npm install` then `npm run vendor`.
- This is a general-purpose media tool. Only download content you have the
  right to.
