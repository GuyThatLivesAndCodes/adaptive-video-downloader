// Download coordinator - bridges manifest parsing, encryption, and the engine
// Handles unified workflow for HLS, DASH, and encrypted streams

import { ManifestParser, StreamNormalizer } from './manifest-parser.js';
import { CryptoEngine, KeyCache } from './crypto-engine.js';
import { SegmentManager, DASHQualitySelector } from './segment-manager.js';

export class DownloadCoordinator {
  constructor(options = {}) {
    this.manifestParser = new ManifestParser();
    this.segmentManager = new SegmentManager(options);
    this.qualitySelector = new DASHQualitySelector();
    this.options = options;
    this.currentJob = null;
    this.listeners = {};
  }

  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => cb(data));
    }
  }

  async detectStreamFromManifest(manifestContent, baseUrl = '') {
    // Try to parse as HLS first
    if (manifestContent.includes('#EXTM3U')) {
      try {
        const parsed = this.manifestParser.parseHLS(manifestContent, baseUrl);
        return this.normalizeForDownload(parsed);
      } catch (e) {
        this.emit('error', `HLS parsing failed: ${e.message}`);
      }
    }

    // Try DASH
    if (manifestContent.includes('<MPD') || manifestContent.includes('xmlns=')) {
      try {
        const parsed = this.manifestParser.parseDASH(manifestContent, baseUrl);
        return this.normalizeForDownload(parsed);
      } catch (e) {
        this.emit('error', `DASH parsing failed: ${e.message}`);
      }
    }

    throw new Error('Unknown manifest format');
  }

  normalizeForDownload(parsed) {
    if (parsed.type === 'HLS') {
      return {
        format: 'HLS',
        segments: parsed.segments,
        encryptionKeys: parsed.keys,
        estimatedSize: this.estimateHLSSize(parsed.segments),
        estimatedDuration: parsed.duration,
      };
    }

    if (parsed.type === 'DASH') {
      const qualityOptions = this.qualitySelector.getAllQualityOptions(parsed.representations);
      const recommended = this.qualitySelector.recommendQuality(parsed.representations);

      return {
        format: 'DASH',
        representations: parsed.representations,
        qualityOptions,
        recommended,
        estimatedSizes: parsed.representations.map(r =>
          this.qualitySelector.estimateFileSize(r)
        ),
      };
    }
  }

  estimateHLSSize(segments) {
    // Average segment size estimation based on typical HLS streams
    // This is a rough estimate; actual size depends on bitrate and duration
    const avgSegmentSize = 500 * 1024; // 500KB per segment
    return segments.length * avgSegmentSize;
  }

  async downloadHLSStream(segments, options = {}) {
    const {
      concurrency = 6,
      onProgress,
      onSegmentComplete,
      retryFailed = true,
    } = options;

    this.segmentManager.addSegments(segments);
    this.emit('start', { format: 'HLS', segmentCount: segments.length });

    try {
      const results = await this.segmentManager.batchDownload({
        concurrency,
        onProgress: (progress) => {
          this.emit('progress', progress);
          if (onProgress) onProgress(progress);
        },
        onSegmentComplete,
      });

      const failed = results.filter(r => r.error);
      if (failed.length > 0 && !retryFailed) {
        this.emit('warning', `${failed.length} segments failed to download`);
      }

      return results.filter(r => !r.error).map(r => r.buffer);
    } catch (error) {
      this.emit('error', error.message);
      throw error;
    }
  }

  async downloadDASHRepresentation(representation, options = {}) {
    const { concurrency = 6, onProgress } = options;

    const segments = representation.segments.map((seg, idx) => ({
      ...seg,
      id: idx,
      url: seg.uri,
    }));

    this.segmentManager.addSegments(segments);
    this.emit('start', {
      format: 'DASH',
      representation: representation.id,
      segmentCount: segments.length,
      bandwidth: representation.bandwidth,
    });

    try {
      const results = await this.segmentManager.batchDownload({
        concurrency,
        onProgress: (progress) => {
          this.emit('progress', progress);
          if (onProgress) onProgress(progress);
        },
      });

      return results.filter(r => !r.error).map(r => r.buffer);
    } catch (error) {
      this.emit('error', error.message);
      throw error;
    }
  }

  async mergeSegments(buffers, format = 'TS') {
    if (format === 'TS' || format === 'HLS') {
      // Simple concatenation for MPEG-TS (used by HLS)
      return this.mergeTS(buffers);
    }
    if (format === 'MP4' || format === 'DASH') {
      // MP4 segments need proper muxing
      return this.mergeMP4(buffers);
    }
    throw new Error(`Unsupported merge format: ${format}`);
  }

  mergeTS(buffers) {
    const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;

    buffers.forEach(buf => {
      const arr = new Uint8Array(buf);
      merged.set(arr, offset);
      offset += arr.byteLength;
    });

    return merged.buffer;
  }

  mergeMP4(buffers) {
    // MP4 merging is more complex and typically requires ffmpeg
    // For now, fall back to simple concatenation
    // In production, this would use proper MP4 muxing
    return this.mergeTS(buffers);
  }

  cancel() {
    this.segmentManager.inProgress.clear();
    this.emit('cancelled');
  }

  getProgress() {
    return this.segmentManager.getProgress();
  }
}

// Helper for intelligent retry with token refresh
export class TokenRefreshHandler {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.tokenRefreshFn = options.tokenRefreshFn;
  }

  async fetchWithTokenRefresh(url, options = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, options);

        // Check for token expiration (typically 401 or 403)
        if ((response.status === 401 || response.status === 403) && this.tokenRefreshFn) {
          const newToken = await this.tokenRefreshFn();
          if (newToken) {
            options.headers = { ...options.headers };
            options.headers['Authorization'] = `Bearer ${newToken}`;
            continue; // Retry with new token
          }
        }

        if (response.ok) {
          return response;
        } else if (response.status >= 500) {
          // Server error, retry
          lastError = new Error(`HTTP ${response.status}`);
          if (attempt < this.maxRetries) {
            await this.exponentialBackoff(attempt);
            continue;
          }
        }

        return response;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries && isRetryableError(error)) {
          await this.exponentialBackoff(attempt);
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }

  async exponentialBackoff(attempt) {
    const delayMs = Math.pow(2, attempt - 1) * 1000;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

function isRetryableError(error) {
  if (!error) return false;
  const msg = error.message.toLowerCase();
  return msg.includes('network') || msg.includes('timeout') || msg.includes('econnrefused');
}
