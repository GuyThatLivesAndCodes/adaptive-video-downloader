// Unified manifest parser for HLS, DASH, and Smooth Streaming formats
// Extracts stream information into a normalized format for download

export class ManifestParser {
  static parseHLS(content, baseUrl = '') {
    const segments = [];
    const keys = [];
    let initSegment = null;
    const lines = content.split('\n');
    let currentKey = null;
    let mediaSequence = 0;
    let duration = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = parseInt(line.split(':')[1], 10) || 0;
      }

      if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        duration = Math.ceil(parseFloat(line.split(':')[1]) || 0);
      }

      if (line.startsWith('#EXT-X-KEY:')) {
        const params = this.parseHLSTag(line);
        if (params.METHOD === 'AES-128') {
          currentKey = {
            method: 'AES-128',
            uri: params.URI,
            iv: params.IV,
          };
          if (!keys.find(k => k.uri === params.URI)) {
            keys.push(currentKey);
          }
        }
      }

      if (line.startsWith('#EXT-X-INITIALIZATION-SECTION:')) {
        const params = this.parseHLSTag(line);
        initSegment = {
          uri: params.URI,
          encrypted: !!currentKey,
          key: currentKey,
        };
      }

      if (line.startsWith('#EXTINF:') && !line.startsWith('#EXT')) {
        const duration = parseFloat(line.split(':')[1]);
        const nextLine = lines[i + 1]?.trim();
        if (nextLine && !nextLine.startsWith('#')) {
          segments.push({
            uri: this.resolveUrl(nextLine, baseUrl),
            duration,
            index: segments.length,
            encrypted: !!currentKey,
            key: currentKey,
          });
        }
      }
    }

    return {
      type: 'HLS',
      segments,
      keys,
      initSegment,
      duration: segments.reduce((sum, s) => sum + s.duration, 0),
      segmentCount: segments.length,
    };
  }

  static parseDASH(content, baseUrl = '') {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/xml');
    if (parser.parseFromString(content, 'text/xml').getElementsByTagName('parsererror').length > 0) {
      throw new Error('Invalid MPD XML');
    }

    const representations = [];
    const periods = doc.querySelectorAll('Period');

    periods.forEach((period, periodIdx) => {
      const adaptationSets = period.querySelectorAll('AdaptationSet');

      adaptationSets.forEach((as) => {
        const reps = as.querySelectorAll('Representation');

        reps.forEach((rep) => {
          const representation = {
            id: rep.getAttribute('id'),
            mimeType: rep.getAttribute('mimeType') || as.getAttribute('mimeType'),
            codecs: rep.getAttribute('codecs') || as.getAttribute('codecs'),
            width: parseInt(rep.getAttribute('width') || as.getAttribute('width'), 10) || null,
            height: parseInt(rep.getAttribute('height') || as.getAttribute('height'), 10) || null,
            bandwidth: parseInt(rep.getAttribute('bandwidth') || as.getAttribute('bandwidth'), 10) || 0,
            segments: [],
            period: periodIdx,
          };

          // Parse SegmentList or SegmentTemplate
          const segmentList = rep.querySelector('SegmentList') || as.querySelector('SegmentList');
          if (segmentList) {
            const baseUrlNode = rep.querySelector('BaseURL') || as.querySelector('BaseURL') || period.querySelector('BaseURL');
            const segmentURI = baseUrlNode?.textContent || rep.getAttribute('BaseURL') || as.getAttribute('BaseURL') || '';
            const initSeg = segmentList.querySelector('Initialization');
            const segments = segmentList.querySelectorAll('SegmentURL');

            let index = 0;
            segments.forEach((seg) => {
              representation.segments.push({
                uri: this.resolveUrl(seg.getAttribute('media') || segmentURI, baseUrl),
                index,
                duration: 0,
              });
              index++;
            });
          }

          // Parse SegmentTemplate (most common)
          const segmentTemplate = rep.querySelector('SegmentTemplate') || as.querySelector('SegmentTemplate');
          if (segmentTemplate && representation.segments.length === 0) {
            const media = segmentTemplate.getAttribute('media');
            const init = segmentTemplate.getAttribute('initialization');
            const timescale = parseInt(segmentTemplate.getAttribute('timescale') || 1000, 10);
            const duration = parseInt(segmentTemplate.getAttribute('duration') || 0, 10);
            const startNumber = parseInt(segmentTemplate.getAttribute('startNumber') || 0, 10);

            // Build segment list based on timeline
            const segmentTimeline = segmentTemplate.querySelector('SegmentTimeline');
            let index = startNumber;

            if (segmentTimeline) {
              const S = segmentTimeline.querySelectorAll('S');
              S.forEach((s) => {
                const d = parseInt(s.getAttribute('d'), 10);
                const r = parseInt(s.getAttribute('r') || 0, 10);
                for (let i = 0; i <= r; i++) {
                  if (media) {
                    representation.segments.push({
                      uri: this.expandDASHUrl(media, index, representation),
                      index,
                      duration: d / timescale,
                    });
                  }
                  index++;
                }
              });
            } else if (duration && media) {
              // Estimate segment count (usually used for on-demand content)
              const totalDuration = parseInt(period.getAttribute('duration') || doc.documentElement.getAttribute('mediaPresentationDuration') || 0, 10);
              const estSegments = Math.ceil(totalDuration / (duration / timescale));
              for (let i = startNumber; i < startNumber + estSegments; i++) {
                representation.segments.push({
                  uri: this.expandDASHUrl(media, i, representation),
                  index: i - startNumber,
                  duration: duration / timescale,
                });
              }
            }
          }

          if (representation.segments.length > 0) {
            representations.push(representation);
          }
        });
      });
    });

    return {
      type: 'DASH',
      representations,
      representationCount: representations.length,
    };
  }

  static parseHLSTag(line) {
    const result = {};
    const tagContent = line.substring(line.indexOf(':') + 1);
    const parts = tagContent.split(',');

    parts.forEach((part) => {
      const [key, ...valueParts] = part.split('=');
      let value = valueParts.join('=');
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      result[key.trim()] = value.trim();
    });

    return result;
  }

  static expandDASHUrl(template, number, representation) {
    return template
      .replace('$Number$', number)
      .replace('$RepresentationID$', representation.id)
      .replace('$Bandwidth$', representation.bandwidth);
  }

  static resolveUrl(url, baseUrl) {
    if (!url) return '';
    if (/^https?:\/\//.test(url)) return url;
    if (!baseUrl) return url;
    try {
      return new URL(url, baseUrl).href;
    } catch (e) {
      return url;
    }
  }
}

export class StreamNormalizer {
  static normalizeForDownload(parsed) {
    if (parsed.type === 'HLS') {
      return {
        format: 'HLS',
        segments: parsed.segments.map((s, i) => ({
          index: i,
          url: s.uri,
          encrypted: s.encrypted,
          encryptionKey: s.key?.uri,
          encryptionIV: s.key?.iv,
        })),
        initSegment: parsed.initSegment,
        encryptionKeys: parsed.keys,
        estimatedDuration: parsed.duration,
        segmentCount: parsed.segmentCount,
      };
    }

    if (parsed.type === 'DASH') {
      const reps = parsed.representations
        .sort((a, b) => b.bandwidth - a.bandwidth)
        .map(rep => ({
          id: rep.id,
          bandwidth: rep.bandwidth,
          width: rep.width,
          height: rep.height,
          codecs: rep.codecs,
          segments: rep.segments.map((s, i) => ({
            index: i,
            url: s.uri,
            duration: s.duration,
          })),
          quality: `${rep.width || '?'}p ${(rep.bandwidth / 1000).toFixed(0)}kbps`,
        }));

      return {
        format: 'DASH',
        representations: reps,
        segmentCounts: reps.map(r => r.segments.length),
      };
    }

    return null;
  }
}
