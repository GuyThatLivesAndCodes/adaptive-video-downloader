// Content script for advanced interception
// Handles blob URL capture, manifest interception, and token extraction
// Runs in page context for access to media elements and local storage

(function() {
  if (window.__avsDownloaderInitialized) return;
  window.__avsDownloaderInitialized = true;

  const capturedBlobs = new Map();
  const capturedRequests = [];

  // Intercept Blob creation to capture video data before it's revoked
  const OriginalBlob = window.Blob;
  const OriginalURL = window.URL;

  window.Blob = class extends OriginalBlob {
    constructor(parts, options) {
      super(parts, options);
      if (parts && parts.length > 0) {
        const firstPart = parts[0];
        if (firstPart instanceof ArrayBuffer || firstPart instanceof Uint8Array) {
          const size = firstPart instanceof ArrayBuffer ? firstPart.byteLength : firstPart.length;
          if (size > 1024 * 100) { // Only capture blobs > 100KB (likely video)
            capturedBlobs.set(this, {
              data: firstPart instanceof ArrayBuffer ? firstPart : firstPart.buffer,
              type: options?.type || 'unknown',
              size,
              timestamp: Date.now(),
            });
          }
        }
      }
      return this;
    }
  };

  // Track blob URL creation/revocation
  const OriginalCreateObjectURL = window.URL.createObjectURL;
  const OriginalRevokeObjectURL = window.URL.revokeObjectURL;

  window.URL.createObjectURL = function(obj) {
    const url = OriginalCreateObjectURL.call(this, obj);
    if (capturedBlobs.has(obj)) {
      capturedBlobs.get(obj).blobUrl = url;
    }
    return url;
  };

  window.URL.revokeObjectURL = function(url) {
    OriginalRevokeObjectURL.call(this, url);
    for (const [blob, info] of capturedBlobs) {
      if (info.blobUrl === url) {
        capturedBlobs.delete(blob);
      }
    }
  };

  // Intercept fetch for manifest/segment requests
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const [resource] = args;
    const url = typeof resource === 'string' ? resource : resource?.url;

    if (url && shouldCapture(url)) {
      capturedRequests.push({
        url,
        headers: resource?.headers || {},
        timestamp: Date.now(),
      });
    }

    return originalFetch.apply(this, args);
  };

  // Intercept XHR
  const OriginalXHR = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    if (shouldCapture(url)) {
      capturedRequests.push({
        url,
        method,
        timestamp: Date.now(),
      });
    }
    return OriginalXHR.apply(this, [method, url, ...args]);
  };

  function shouldCapture(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return (
      lower.includes('.m3u8') ||
      lower.includes('.mpd') ||
      lower.includes('.m4s') ||
      lower.includes('.ts') ||
      lower.includes('.mp4') ||
      lower.includes('manifest') ||
      lower.includes('segment') ||
      lower.includes('media')
    );
  }

  // Export captured data to background script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data.type === 'AVD_GET_CAPTURED_BLOBS') {
      const blobs = Array.from(capturedBlobs.entries()).map(([, info]) => ({
        type: info.type,
        size: info.size,
        timestamp: info.timestamp,
      }));

      window.postMessage({
        type: 'AVD_CAPTURED_BLOBS',
        blobs,
        requestCount: capturedRequests.length,
      }, '*');
    }

    if (event.data.type === 'AVD_GET_TOKENS') {
      const tokens = extractTokensFromPage();
      window.postMessage({
        type: 'AVD_TOKENS',
        tokens,
      }, '*');
    }
  });

  function extractTokensFromPage() {
    const tokens = {};

    // Check localStorage for auth tokens
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.toLowerCase().includes('token') || key.toLowerCase().includes('auth'))) {
          tokens[key] = localStorage.getItem(key).substring(0, 50);
        }
      }
    } catch (e) {
      // localStorage may not be accessible
    }

    // Check sessionStorage
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && (key.toLowerCase().includes('token') || key.toLowerCase().includes('auth'))) {
          tokens[key] = sessionStorage.getItem(key).substring(0, 50);
        }
      }
    } catch (e) {
      // sessionStorage may not be accessible
    }

    // Extract from cookies
    const cookies = document.cookie.split(';').reduce((acc, c) => {
      const [key, value] = c.trim().split('=');
      if (key && (key.toLowerCase().includes('token') || key.toLowerCase().includes('session'))) {
        acc[key] = (value || '').substring(0, 50);
      }
      return acc;
    }, {});
    Object.assign(tokens, cookies);

    return tokens;
  }

  // Listen for messages from background script
  chrome.runtime?.onMessage?.addListener((request, sender, sendResponse) => {
    if (request.type === 'getPageContext') {
      sendResponse({
        blobs: Array.from(capturedBlobs.entries()).map(([, info]) => ({
          type: info.type,
          size: info.size,
        })),
        requests: capturedRequests.slice(-20),
        tokens: extractTokensFromPage(),
        url: window.location.href,
      });
    }
  });
})();
