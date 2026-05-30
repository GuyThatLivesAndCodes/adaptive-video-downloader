// Segment manager for intelligent download coordination
// Handles quality selection, encryption, retries, and batch operations

import { CryptoEngine, KeyCache } from './crypto-engine.js';

export class SegmentManager {
  constructor(options = {}) {
    this.segments = [];
    this.encryptionKeys = new KeyCache();
    this.completed = new Set();
    this.failed = new Set();
    this.inProgress = new Set();
    this.maxRetries = options.maxRetries || 3;
    this.timeout = options.timeout || 30000;
  }

  addSegments(segments) {
    this.segments = segments.map((seg, idx) => ({
      ...seg,
      id: idx,
      retries: 0,
      status: 'pending',
    }));
  }

  getProgress() {
    const total = this.segments.length;
    const completed = this.completed.size;
    const failed = this.failed.size;
    const pending = total - completed - failed;

    return {
      total,
      completed,
      failed,
      pending,
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }

  async downloadSegment(segment, options = {}) {
    const { onProgress } = options;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      this.inProgress.add(segment.id);
      const response = await fetch(segment.url, {
        signal: controller.signal,
        cache: 'no-store',
        ...options.fetchOptions,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      let buffer = await response.arrayBuffer();

      if (segment.encrypted && segment.encryptionKey) {
        try {
          buffer = await CryptoEngine.decryptAES128CBC(
            buffer,
            await this.encryptionKeys.getKey(segment.encryptionKey),
            segment.encryptionIV
          );
        } catch (e) {
          throw new Error(`Decryption failed: ${e.message}`);
        }
      }

      segment.status = 'completed';
      this.completed.add(segment.id);
      this.inProgress.delete(segment.id);

      if (onProgress) onProgress(this.getProgress());

      return buffer;
    } catch (error) {
      this.inProgress.delete(segment.id);

      segment.retries = (segment.retries || 0) + 1;
      if (segment.retries >= this.maxRetries) {
        segment.status = 'failed';
        this.failed.add(segment.id);
      } else {
        segment.status = 'pending';
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async downloadWithRetry(segment, options = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.downloadSegment(segment, options);
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  async batchDownload(options = {}) {
    const { concurrency = 6, onProgress, onSegmentComplete } = options;
    const pendingSegments = this.segments.filter(s => s.status === 'pending');
    const results = [];

    for (let i = 0; i < pendingSegments.length; i += concurrency) {
      const batch = pendingSegments.slice(i, i + concurrency);
      const batchPromises = batch.map(seg =>
        this.downloadWithRetry(seg, { onProgress })
          .then(buffer => {
            if (onSegmentComplete) onSegmentComplete(seg.id, buffer);
            return { segmentId: seg.id, buffer, error: null };
          })
          .catch(error => {
            return { segmentId: seg.id, buffer: null, error };
          })
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }

  getPendingSegments() {
    return this.segments.filter(s => s.status === 'pending');
  }

  getFailedSegments() {
    return this.segments.filter(s => s.status === 'failed');
  }

  reset() {
    this.completed.clear();
    this.failed.clear();
    this.inProgress.clear();
    this.segments.forEach(s => {
      s.status = 'pending';
      s.retries = 0;
    });
  }
}

export class DASHQualitySelector {
  static recommendQuality(representations, preferredBandwidth = null) {
    if (!representations || representations.length === 0) {
      return null;
    }

    // Sort by bandwidth descending
    const sorted = [...representations].sort((a, b) => b.bandwidth - a.bandwidth);

    if (preferredBandwidth) {
      // Find representation closest to preferred bandwidth without exceeding it
      return sorted.find(r => r.bandwidth <= preferredBandwidth) || sorted[sorted.length - 1];
    }

    // Return highest quality
    return sorted[0];
  }

  static getAllQualityOptions(representations) {
    if (!representations || representations.length === 0) {
      return [];
    }

    return representations
      .sort((a, b) => b.bandwidth - a.bandwidth)
      .map(rep => ({
        id: rep.id,
        label: rep.quality || `${rep.bandwidth / 1000}kbps`,
        bandwidth: rep.bandwidth,
        width: rep.width,
        height: rep.height,
        codecs: rep.codecs,
        segmentCount: rep.segments.length,
      }));
  }

  static estimateFileSize(representation, formatOverhead = 1.05) {
    const totalBytes = representation.segments.reduce((sum, seg) => {
      // Estimate: bandwidth * duration / 8 (bits to bytes)
      return sum + (representation.bandwidth * seg.duration / 8);
    }, 0);

    return Math.ceil(totalBytes * formatOverhead);
  }

  static estimateDownloadTime(sizeBytes, bandwidthKbps, concurrency = 6) {
    const bytesPerSecond = (bandwidthKbps * 1000) / 8;
    const effectiveBandwidth = bytesPerSecond * Math.min(concurrency, 24);
    return sizeBytes / effectiveBandwidth;
  }
}
