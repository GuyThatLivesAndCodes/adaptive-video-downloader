// Cryptography engine for handling encrypted video segments
// Supports AES-128-CBC (HLS) and AES-128-GCM (modern protocols)

export class CryptoEngine {
  static async decryptAES128CBC(ciphertext, key, iv) {
    if (!(ciphertext instanceof ArrayBuffer)) {
      ciphertext = this.toArrayBuffer(ciphertext);
    }
    if (!(key instanceof ArrayBuffer)) {
      key = this.toArrayBuffer(key);
    }
    if (!(iv instanceof ArrayBuffer)) {
      iv = this.toArrayBuffer(iv);
    }

    if (key.byteLength !== 16) {
      throw new Error(`AES-128 key must be 16 bytes, got ${key.byteLength}`);
    }
    if (iv.byteLength !== 16) {
      throw new Error(`AES-128 IV must be 16 bytes, got ${iv.byteLength}`);
    }

    try {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
      );

      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv },
        cryptoKey,
        ciphertext
      );

      return plaintext;
    } catch (error) {
      throw new Error(`AES-128-CBC decryption failed: ${error.message}`);
    }
  }

  static async decryptAES128GCM(ciphertext, key, nonce, aad = null) {
    if (!(ciphertext instanceof ArrayBuffer)) {
      ciphertext = this.toArrayBuffer(ciphertext);
    }
    if (!(key instanceof ArrayBuffer)) {
      key = this.toArrayBuffer(key);
    }
    if (!(nonce instanceof ArrayBuffer)) {
      nonce = this.toArrayBuffer(nonce);
    }

    if (key.byteLength !== 16) {
      throw new Error(`AES-128 key must be 16 bytes, got ${key.byteLength}`);
    }

    try {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );

      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: aad ? this.toArrayBuffer(aad) : undefined,
        },
        cryptoKey,
        ciphertext
      );

      return plaintext;
    } catch (error) {
      throw new Error(`AES-128-GCM decryption failed: ${error.message}`);
    }
  }

  static async fetchAndDecryptSegment(segmentUrl, encryptionKey, encryptionIV) {
    try {
      const response = await fetch(segmentUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const encryptedBuffer = await response.arrayBuffer();

      if (!encryptionKey) {
        return encryptedBuffer;
      }

      // Parse key and IV (usually base64 in HLS manifests)
      const keyBuffer = this.parseKey(encryptionKey);
      const ivBuffer = encryptionIV ? this.parseKey(encryptionIV) : null;

      if (ivBuffer && ivBuffer.byteLength === 16) {
        return await this.decryptAES128CBC(encryptedBuffer, keyBuffer, ivBuffer);
      } else {
        return await this.decryptAES128CBC(encryptedBuffer, keyBuffer, new Uint8Array(16));
      }
    } catch (error) {
      throw new Error(`Failed to fetch/decrypt segment: ${error.message}`);
    }
  }

  static parseKey(keyStr) {
    // Handle base64, hex, or data URI formats
    if (!keyStr) return null;

    if (keyStr.startsWith('data:')) {
      const [, data] = keyStr.split(',');
      return this.base64ToArrayBuffer(data);
    }

    // Try base64 first (most common)
    try {
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(keyStr)) {
        return this.base64ToArrayBuffer(keyStr);
      }
    } catch (e) {
      // Not base64, try hex
    }

    // Try hex format
    if (/^[0-9a-fA-F]+$/.test(keyStr) && keyStr.length % 2 === 0) {
      return this.hexToArrayBuffer(keyStr);
    }

    // Try as-is (might be binary string)
    return this.toArrayBuffer(keyStr);
  }

  static base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  static hexToArrayBuffer(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes.buffer;
  }

  static toArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return data;
    if (data instanceof Uint8Array || data instanceof Uint16Array || data instanceof Uint32Array) {
      return data.buffer;
    }
    if (typeof data === 'string') {
      const encoder = new TextEncoder();
      return encoder.encode(data).buffer;
    }
    throw new Error(`Cannot convert ${typeof data} to ArrayBuffer`);
  }

  static arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  static arrayBufferToHex(buffer) {
    const bytes = new Uint8Array(buffer);
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

export class KeyCache {
  constructor() {
    this.cache = new Map();
  }

  async getKey(uri, fetchFn = fetch) {
    if (this.cache.has(uri)) {
      return this.cache.get(uri);
    }

    try {
      const response = await fetchFn(uri);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const keyBuffer = await response.arrayBuffer();
      this.cache.set(uri, keyBuffer);
      return keyBuffer;
    } catch (error) {
      throw new Error(`Failed to fetch key from ${uri}: ${error.message}`);
    }
  }

  clear() {
    this.cache.clear();
  }
}
