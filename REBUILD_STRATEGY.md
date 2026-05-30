# Adaptive Video Downloader — Rebuild Strategy

## Executive Summary

The current implementation is technically solid but suffers from a technical, uninviting UI that doesn't inspire trust. This strategy outlines:

1. **UI/UX redesign** moving from dark "developer" aesthetic to a clean, modern, professional interface
2. **Technical expansion** to handle encryption, DRM-adjacent protection, and modern streaming protocols
3. **Architecture improvements** for maintainability and future capability expansion

---

## Part 1: UI/UX Redesign Strategy

### Current State Issues
- Dark theme feels technical/hacker-ish
- Uppercase labels and tiny fonts reduce approachability
- Status messaging uses "network activity" language (jargon)
- Visual hierarchy is flat
- No sense of progress or reassurance during scanning

### Target Design Philosophy
**"Professional, trustworthy, invisible when it works"**

Users should feel like they're using a polished app, not a technical tool. The interface should:
- Build trust through clarity and transparency
- Reduce cognitive load with smart defaults
- Guide users naturally through workflows
- Provide reassurance with meaningful status updates

### Design System Changes

#### Color Palette
```
Light/Approachable Theme:
--bg:             #ffffff (clean white)
--surface:        #f8f8fa (subtle off-white)
--surface-2:      #ececf0 (slightly darker for depth)
--accent:         #3b82f6 (professional blue, not light gray)
--accent-text:    #ffffff
--text-primary:   #1a1a1a (dark gray, not pure black)
--text-secondary: #666666 (muted but readable)
--success:        #10b981 (emerald green)
--warning:        #f59e0b (amber)
--danger:         #ef4444 (red)
--border:         #e5e5e7 (subtle)
--border-focus:   #3b82f6 (accent blue on focus)

Option: Dark Mode Toggle
If users prefer dark, provide a professional dark variant:
--bg:             #111827
--surface:        #1f2937
--accent:         #60a5fa (lighter blue for dark)
--text-primary:   #f3f4f6
```

#### Typography Hierarchy
```
Primary Actions:      16px, 600 weight, accent color
Secondary Actions:    14px, 500 weight, text-primary
Labels:              12px, 500 weight, text-secondary (not uppercase)
Body:                14px, 400 weight, text-primary
Helper Text:         12px, 400 weight, text-secondary
```

### UI Layout Changes

#### 1. Header Redesign
```
BEFORE:
  [icon] Adaptive Video Downloader

AFTER:
  Video Downloader
  Scanning this page... (smaller, helpful subtitle)
```
- Remove icon box styling, integrate icon naturally
- Add meaningful status subtitle
- Larger, cleaner typography
- Light background with proper breathing room

#### 2. Scanning State
```
BEFORE:
  "Scanning network activity…" (gray text)

AFTER:
  Animated section with:
  • Small animated dots or spinner
  • "Looking for videos on this page..."
  • Visual indicator showing detection progress
  • If nothing found: helpful guidance like "Load a video first"
```

#### 3. Stream Selection
```
BEFORE:
  "SEGMENT STREAMS — PICK ONE" (uppercase label)
  [dropdown]
  "Random test" button

AFTER:
  "Found video streams (3)"
  [dropdown with improved styling]
  
  Video details shown clearly:
  • Resolution/bitrate (inferred from URL)
  • Duration estimate
  • Format type (HLS, Progressive)
  • Size estimate
  
  Single unified button: "Test stream" with icon
  (testing happens automatically with visual feedback)
```

#### 4. Direct Files Section
```
BEFORE:
  "DIRECT VIDEO FILES" label
  [list of files with minimal info]

AFTER:
  "Videos ready to download (5)"
  
  Cards with:
  • Thumbnail/video icon
  • Filename (truncated smartly)
  • Size and duration
  • Quality badge (if detectable)
  • Single-tap download button
```

#### 5. Speed Selector
```
BEFORE:
  "DOWNLOAD SPEED" label
  [3 button group] Normal / Fast / Hyper

AFTER:
  Integrated into download flow:
  
  In a collapsible "Advanced" section or inline:
  ⚙️ Download speed
     ⊚ Balanced (default)
     ⊚ Fast
     ⊚ Aggressive
  
  With descriptors:
  • Balanced: Standard speed, courteous
  • Fast: Higher parallelism
  • Aggressive: Maximum speed
```

#### 6. Download Progress Screen
```
BEFORE:
  Title: "Preparing download…"
  Label: filename
  Progress bar
  Stats text
  Log section

AFTER:
  Large, reassuring layout:
  
  ╔══════════════════════════╗
  │                          │
  │   [video icon] 🎬       │
  │   Downloading...        │
  │   filename.ts           │
  │   73% Complete          │
  │                          │
  │   ████████░░ 73%        │
  │   2.3 GB / 3.1 GB       │
  │   12 MB/s (2m 15s left) │
  │                          │
  │  [Full screen view]      │
  │  [Keep running note]     │
  │                          │
  │  ◀️ Back    Stop & Save  │
  └──────────────────────────┘
```

#### 7. Lockdown/Blocked Sites
```
BEFORE:
  Red lock icon
  "Downloading not available"

AFTER:
  Icon: 🔒 (real emoji or SVG)
  
  "YouTube not supported"
  
  Clear explanation:
  "YouTube uses special streaming that needs 
   YouTube's own player to download. We can't 
   replicate that without violating their terms.
   
   Try: Use youtube-dl, yt-dlp, or YouTube's 
   download feature (Premium)."
   
  [Link to alternatives]
```

### Interaction Improvements

#### Discoverability
- **Hover tooltips**: Show full URLs on hover (still valuable)
- **Smart defaults**: Pre-select the best quality stream
- **Visual feedback**: Button states clear and immediate
- **Loading states**: Show animated spinners, not just text

#### Trust Signals
- Show what's being scanned: "Checking 147 network requests..."
- Explain test results clearly: "✓ Stream is accessible and complete (45 segments)"
- Display file sizes estimated from URL patterns
- Show format/codec information when available

#### Accessibility
- Proper contrast ratios (WCAG AA minimum)
- Keyboard navigation throughout
- Screen reader friendly labels
- Error messages that explain solutions

### CSS Architecture
```
popup.css structure:
├── Variables (colors, spacing, typography)
├── Base styles
├── Layout (header, main sections)
├── Components
│   ├── Buttons
│   ├── Forms/Selects
│   ├── Lists
│   ├── Progress indicators
│   ├── Cards
│   └── Status messages
├── States (loading, success, error)
├── Dark mode (optional toggle)
└── Responsive (mobile-friendly where possible)
```

---

## Part 2: Technical Strategy for Video Download & Encryption

### Current Capabilities
✓ HLS segment detection and merging
✓ Progressive MP4 download
✓ Token-signed CDN requests
✓ Basic format detection
✓ MP4 remux via ffmpeg.wasm

### Barriers to Overcome

#### 1. Encryption & DRM-Adjacent Protection

**Modern Video Encryption Landscape:**

Most premium sites don't use formal DRM (Widevine/PlayReady) for all content, but use:
- **DASH Encryption**: Content key encryption with client manifest
- **HLS Encryption**: AES-128-CBC with IV in manifest
- **Blob URLs**: Dynamic streaming with fetch-required tokens
- **Referer/Cookie enforcement**: Token tied to session

**Implementation Strategy:**

```
A. HLS Encryption Handling
   - Parse M3U8 manifests for EXT-X-KEY directives
   - Extract encryption key URLs and parameters
   - Fetch keys server-side (background worker)
   - Decrypt segments on-the-fly with crypto-js or libsodium.js
   - Current: Only works if key is in manifest
   - Upgrade: Intercept key requests, cache keys

B. DASH Encryption
   - Parse MPD (DASH manifest) XML
   - Extract ContentProtection nodes
   - If non-DRM (clearkey, encrypted), extract keys from manifest
   - Decrypt init segment and media segments
   - Requires: crypto library for AES decryption
   
C. Blob URL Handling
   - Vidplay/similar: Uses blob: URLs that require page context
   - Solution: Inject content script to intercept Blob creation
   - Store ArrayBuffer before blob revocation
   - Send raw buffers to background for merging
   - Requires: CSP-compatible injection

D. Referer/Cookie Enforcement
   - Upgrade background.js webRequest to include:
     * Original tab's cookies
     * Referer headers from video context
     * User-Agent matching
   - Send segments through authenticated fetch from content context
```

#### 2. Vidplay-Specific Protection

**What Vidplay Does:**
- Segments hosted on CDN with short-lived tokens (5-10 min)
- Manifest loads segments sequentially (not random access)
- Uses blob: URLs for actual playback
- May encrypt segments with AES-128
- Enforces Referer: to player domain

**Our Approach:**
```
1. Manifest Interception
   - Content script watches for fetch/XHR to manifest
   - Extracts all segment URLs before they expire
   - Pre-fetches with current auth headers
   - Caches all segments immediately (parallel download)

2. Token Preservation
   - Keep tokens fresh by:
     a) Requesting new manifest if old tokens expire
     b) Extracting fresh tokens from updated manifest
     c) Batch-downloading while tokens valid

3. Encryption Bypass
   - If segments are AES-128 encrypted:
     a) Extract key from manifest (usually present)
     b) Decrypt using TweetNaCl.js or libsodium.js
     c) Return cleartext for merging

4. User Experience
   - Show: "Found 247 segments, caching..."
   - Download in background even if token expires
   - Re-authenticate if needed (show message)
```

#### 3. Streaming Protocol Support

**Current:**
- HLS (basic, unencrypted)
- Progressive (MP4, WebM)

**Add:**
- **HLS+ (encrypted)**
  - AES-128-CBC decryption
  - Key rotation handling
  - Fragment initialization segments

- **DASH (unencrypted)**
  - MPD parsing
  - Byte-range requests
  - Rep/adaptation set selection
  - Init segment handling
  - Timeline stitching

- **Smooth Streaming (MS-SSTR)**
  - Manifest parsing (XML)
  - Fragment URL template expansion
  - Quality tier selection

- **Progressive with ByteRange**
  - HTTP Range request optimization
  - Resume capability

### Architecture Changes

#### Background Worker Expansion
```javascript
// background.js enhancements:

class SegmentCache {
  constructor() {
    this.segments = new Map();
    this.pendingRequests = new Set();
  }
  
  // Cache encrypted segments
  async storeSegment(index, buffer, encrypted = false, key = null) {
    if (encrypted && key) {
      buffer = await this.decrypt(buffer, key);
    }
    this.segments.set(index, buffer);
  }
  
  async decrypt(buffer, key) {
    // AES-128-CBC decryption
    // Use crypto-js or TweetNaCl.js
  }
}

class ManifestParser {
  // Unified parser for:
  // - M3U8 (HLS)
  // - MPD (DASH)
  // - PIFF (Smooth Streaming)
  
  parseHLS(content) {
    // Extract segments, keys, init segments
  }
  
  parseDASH(content) {
    // Extract periods, adaptationSets, representations
  }
}

class DownloadEngine {
  // Enhanced with:
  // - Segment decryption
  // - Adaptive quality selection
  // - Resume/partial download recovery
  // - Multi-manifest stitching
  
  async downloadStream(manifest, options = {}) {
    // Smart parallelism
    // Key fetching and caching
    // Automatic retry with token refresh
  }
}
```

#### Content Script Injection
```javascript
// contentScript.js (new)
// Injected to page to intercept:
// - Blob creation for segment playback
// - Fetch/XHR to manifests
// - Local storage tokens
// - AuthHeaders from requests

// Benefits:
// - Access to page's auth context
// - Can intercept before data is lost
// - Can hook into media playback events

class PayloadInterceptor {
  interceptBlobs() {
    // Capture ArrayBuffer before blob revocation
  }
  
  interceptFetch() {
    // Log all video-related requests
    // Extract manifests and segments
  }
  
  captureHeaders() {
    // Get cookies, auth tokens, referer
  }
}
```

#### Enhanced Manifest Handling
```javascript
// manifestProcessor.js (new)

class HLSProcessor {
  // Support for:
  // - Multiple key formats (URI, in-manifest)
  // - Fragment initialization segments
  // - Encryption with IV rotation
  // - Discontinuity markers
  // - #EXT-X-BYTERANGE support
  
  parseM3U8Extended(content) {
    const segments = [];
    const keys = [];
    const initSegment = null;
    
    // Full spec compliance
    return { segments, keys, initSegment };
  }
}

class DASHProcessor {
  // Full MPD v3 support
  // Handles:
  // - Period-based content
  // - Representation switching
  // - SegmentTimeline
  // - Multiple periods (live streams)
  // - Media segments with templates
  
  parseMPD(content, baseUrl) {
    // Extract all possible representations
    // Return quality options for user selection
  }
}
```

### Decryption Implementation

```javascript
// crypto-engine.js (new)

import TweetNaCl from 'tweetnacl';
// or: import * as libsodium from 'libsodium.js';

class DecryptionEngine {
  async decryptAES128CBC(ciphertext, key, iv) {
    // Standard AES-128 in CBC mode (HLS standard)
    // key: Buffer (16 bytes)
    // iv: Buffer (16 bytes)
    // Returns: ArrayBuffer
    
    // Using SubtleCrypto (native browser API):
    const cryptoKey = await crypto.subtle.importKey(
      'raw', key, { name: 'AES-CBC' }, false, ['decrypt']
    );
    
    return crypto.subtle.decrypt(
      { name: 'AES-CBC', iv },
      cryptoKey,
      ciphertext
    );
  }
  
  async decryptAES128GCM(ciphertext, key, nonce, aad = null) {
    // For DASH and modern HLS
    // More secure than CBC
  }
  
  extractKeyFromURL(keyUri) {
    // Download key from URI
    // Cache for reuse
  }
}
```

### Error Recovery & Resilience

```javascript
class RobustDownloader {
  async downloadWithRecovery(stream, options = {}) {
    const { maxRetries = 5, tokenRefreshFn } = options;
    const failures = [];
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Attempt download
        // If token expires: call tokenRefreshFn()
        // Retry with fresh token
        
      } catch (error) {
        failures.push({ segment: i, error, attempt });
        
        if (error.code === 'TOKEN_EXPIRED') {
          // Refresh token and retry
          continue;
        }
        
        if (error.code === 'NOT_FOUND') {
          // End of stream, save what we have
          break;
        }
      }
    }
    
    return { success, failures, recovered: failures.length };
  }
}
```

### Quality Selection & Recommendations

```javascript
class QualitySelector {
  analyzeStream(representations) {
    // Rank by: bitrate, resolution, codec efficiency
    // Return: [best, good, basic] options
    
    return {
      recommended: repr[0], // Highest practical quality
      options: repr.map(r => ({
        label: `${r.width}p ${r.bitrate}kbps`,
        size: estimateSize(r.bandwidth, duration),
        repr: r
      }))
    };
  }
  
  // Show options to user with:
  // - Visual resolution
  // - Estimated size
  // - Download time estimate
}
```

### New Features Enabled by This Architecture

1. **HLS+ Downloads** (encrypted + signed)
   - Works with Vimeo, Wistia, encrypted livestreams
   
2. **DASH Downloads** (unencrypted)
   - YouTube-style adaptive streams (without DRM)
   - Better quality selection
   
3. **Manifest Stitching**
   - Download multi-period content
   - Livestreams (if segments retained)
   
4. **Token Management**
   - Auto-refresh expiring tokens
   - Batch pre-fetch while tokens valid
   
5. **Encryption Transparency**
   - Auto-detect and decrypt AES-128
   - Show decryption status to user
   
6. **Quality Selection UI**
   - Let user choose resolution/bitrate
   - Show file size estimates
   
7. **Resume Downloads**
   - Store partial segments
   - Restart from last complete segment
   
8. **Format Conversion**
   - Beyond MP4: WebM, MKV (ffmpeg capable)
   - Audio-only mode (M4A, MP3)

---

## Part 3: Implementation Roadmap

### Phase 1: UI/UX Redesign (2-3 weeks)
```
1. Design system setup
   - New CSS variables
   - Component library
   - Dark/light theme foundation
   
2. Popup redesign
   - New layout and spacing
   - Visual components (cards, lists)
   - Status messages and animations
   
3. Interaction polish
   - Transitions and feedback
   - Hover/focus states
   - Loading indicators
   
4. Testing & refinement
   - Cross-browser testing
   - Feedback iteration
```

### Phase 2: Encryption & DASH Support (4-6 weeks)
```
1. Manifest parsing
   - Add DASH MPD parser
   - Enhance HLS M3U8 parser
   - Normalize to internal format
   
2. Decryption engine
   - AES-128 CBC/GCM support
   - Key extraction and caching
   - Testing with encrypted HLS streams
   
3. DASH download handler
   - Segment assembly
   - Initialization segment handling
   - Quality selection
   
4. Testing
   - Encrypted streams (Vimeo, etc.)
   - DASH manifests
   - Edge cases (key rotation, etc.)
```

### Phase 3: Vidplay & Advanced Protection (3-4 weeks)
```
1. Content script enhancement
   - Blob interception
   - Fetch monitoring
   - Token extraction
   
2. Token refresh logic
   - Automatic manifest re-fetch
   - Token rotation handling
   - Session preservation
   
3. Vidplay-specific handling
   - Caching strategy
   - Parallel download while tokens valid
   - Fallback strategies
   
4. Testing on Vidplay sites
   - Integration testing
   - Error recovery verification
```

### Phase 4: Polish & Release (2-3 weeks)
```
1. Bug fixes
   - Edge case handling
   - Error messages
   - Recovery flows
   
2. Performance optimization
   - Memory usage during large downloads
   - Crypto operation efficiency
   
3. Documentation
   - User guide
   - Troubleshooting
   - Changelog
   
4. Store submission
   - Chrome Web Store
   - Firefox Add-ons
```

---

## Technical Debt & Modernization

### Current Code Quality
- ✓ Well-structured background architecture
- ✓ Clean separation of concerns
- ✓ Manifest V2 → V3 coverage
- ✗ No error recovery for token expiration
- ✗ Limited format support
- ✗ No encryption handling

### Recommended Refactors
1. Extract segment merging logic into separate module
2. Create unified manifest interface for HLS/DASH
3. Implement proper error types and handling
4. Add comprehensive logging (development mode)
5. Build test suite with sample manifests

---

## Success Metrics

### UI/UX
- Time to download (from click to finish): < 10 seconds for simple streams
- Complexity perception: Users can download without reading docs
- Trust score: Professional appearance, clear status communication

### Technical
- Encryption support: 90%+ of protected streams
- Format support: HLS, DASH, Progressive, Smooth Streaming
- Reliability: < 1% failure rate on token-protected streams
- Performance: Download 100+ segments in parallel without browser issues

---

## Competitive Advantage Over Video DownloadHelper

1. **Open Source**: Community improvements vs. closed service
2. **No Subscription**: Free downloads vs. paid-only features
3. **Modern UI**: 2024+ design vs. dated interface
4. **Transparent**: Clear what's happening vs. magic black box
5. **Ethical**: No DRM bypass (legal clarity)
6. **User Control**: Choose quality, speed, format
7. **Local Processing**: No server uploads, full privacy
8. **Multiple Platforms**: Chrome + Firefox native

---

## Summary

This rebuild transforms the downloader from a technically capable but intimidating tool into a professional, user-centric application while adding critical missing features (encryption handling, DASH support, token management). The phased approach allows continuous delivery and testing while managing complexity.

**Key philosophy**: Make the complex invisible. Users should never see the technical complexity—just simple workflows that reliably work.
