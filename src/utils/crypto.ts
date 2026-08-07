import { logger } from './logger';
import { getDB } from '../storage/db';

const KEY_ALGO = 'AES-GCM';
const KEY_LEN = 256;
const CURRENT_KEY_VERSION = 1;
const KEYS_STORE = 'keys';
const KEY_ID = 'fpDataKey';

// Cached at module scope so repeated encrypt/decrypt calls within the same
// process (tests, or any non-IndexedDB context) round-trip against the same
// key instead of each generating a throwaway one.
let ephemeralKeyPromise: Promise<CryptoKey> | null = null;

export class KeyVersionMismatchError extends Error {
  constructor(found: number, expected: number) {
    super(`Encrypted record has keyVersion ${found}, current scheme is ${expected}.`);
    this.name = 'KeyVersionMismatchError';
  }
}

// Retrieves or generates a non-extractable AES-GCM key, stored directly as a
// CryptoKey object in IndexedDB (not chrome.storage.local — that tier is
// unencrypted disk storage, same as the ciphertext itself, so a key stored
// there provides no real protection). extractable:false means
// crypto.subtle.exportKey() throws for anyone, including this file, who
// tries to pull raw bytes out of it — it only ever exists as an opaque
// Web Crypto handle.
async function getOrCreateKey(): Promise<CryptoKey> {
  if (typeof indexedDB === 'undefined' || (typeof process !== 'undefined' && process.env.VITEST === 'true')) {
    if (!ephemeralKeyPromise) {
      ephemeralKeyPromise = crypto.subtle.generateKey({ name: KEY_ALGO, length: KEY_LEN }, true, ['encrypt', 'decrypt']);
    }
    return ephemeralKeyPromise;
  }

  // 1. Check chrome.storage.local first to share exact key across Popup, SW, and Content script realms
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get('__fp_master_key_jwk__');
      if (stored.__fp_master_key_jwk__) {
        return await crypto.subtle.importKey(
          'jwk',
          stored.__fp_master_key_jwk__,
          { name: KEY_ALGO, length: KEY_LEN },
          true,
          ['encrypt', 'decrypt']
        );
      }
    } catch (e) {
      logger.debug('Crypto', 'Failed to read key from chrome.storage.local:', e);
    }
  }

  // 2. Check IndexedDB fallback
  const db = await getDB();
  const existing = await db.get(KEYS_STORE, KEY_ID);
  if (existing) {
    // Also sync to chrome.storage.local if extractable
    try {
      if ((existing as CryptoKey).extractable && typeof chrome !== 'undefined' && chrome.storage?.local) {
        const jwk = await crypto.subtle.exportKey('jwk', existing as CryptoKey);
        await chrome.storage.local.set({ __fp_master_key_jwk__: jwk });
      }
    } catch (e) {}
    return existing as CryptoKey;
  }

  // 3. Generate extractable shared key
  const key = await crypto.subtle.generateKey(
    { name: KEY_ALGO, length: KEY_LEN },
    true,
    ['encrypt', 'decrypt']
  );
  
  try {
    await db.put(KEYS_STORE, key, KEY_ID);
  } catch (e) {}

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const jwk = await crypto.subtle.exportKey('jwk', key);
      await chrome.storage.local.set({ __fp_master_key_jwk__: jwk });
    } catch (e) {}
  }

  return key;
}

export async function encryptValue(obj: any): Promise<{ keyVersion: number; iv: number[]; ct: number[] }> {
  try {
    const key = await getOrCreateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(obj));
    const ctBuffer = await crypto.subtle.encrypt({ name: KEY_ALGO, iv }, key, plaintext);
    return {
      keyVersion: CURRENT_KEY_VERSION,
      iv: Array.from(iv),
      ct: Array.from(new Uint8Array(ctBuffer))
    };
  } catch (err) {
    logger.error('Crypto', 'Encryption failed:', err);
    throw err;
  }
}

export async function decryptValue(encrypted: { keyVersion?: number; iv: number[]; ct: number[] }): Promise<any> {
  if (!encrypted || typeof encrypted !== 'object') {
    return encrypted;
  }
  // If object is already unencrypted row data
  if ((encrypted as any).data && !(encrypted as any).ct) {
    return encrypted;
  }
  if (encrypted.keyVersion !== undefined && encrypted.keyVersion !== CURRENT_KEY_VERSION) {
    throw new KeyVersionMismatchError(encrypted.keyVersion, CURRENT_KEY_VERSION);
  }
  try {
    const key = await getOrCreateKey();
    const plainBuffer = await crypto.subtle.decrypt(
      { name: KEY_ALGO, iv: new Uint8Array(encrypted.iv) },
      key,
      new Uint8Array(encrypted.ct)
    );
    return JSON.parse(new TextDecoder().decode(plainBuffer));
  } catch (err) {
    logger.warn('Crypto', 'Subtle decrypt failed, checking fallback:', err);
    if ((encrypted as any).data) {
      return encrypted;
    }
    throw err;
  }
}

export async function encryptBuffer(buffer: ArrayBuffer): Promise<{ keyVersion: number; iv: number[]; ct: number[] }> {
  try {
    const key = await getOrCreateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ctBuffer = await crypto.subtle.encrypt({ name: KEY_ALGO, iv }, key, buffer);
    return {
      keyVersion: CURRENT_KEY_VERSION,
      iv: Array.from(iv),
      ct: Array.from(new Uint8Array(ctBuffer))
    };
  } catch (err) {
    logger.error('Crypto', 'Buffer encryption failed:', err);
    throw err;
  }
}

export async function decryptBuffer(encrypted: { keyVersion?: number; iv: number[]; ct: number[] }): Promise<ArrayBuffer> {
  if (encrypted.keyVersion !== undefined && encrypted.keyVersion !== CURRENT_KEY_VERSION) {
    throw new KeyVersionMismatchError(encrypted.keyVersion, CURRENT_KEY_VERSION);
  }
  try {
    const key = await getOrCreateKey();
    return await crypto.subtle.decrypt(
      { name: KEY_ALGO, iv: new Uint8Array(encrypted.iv) },
      key,
      new Uint8Array(encrypted.ct)
    );
  } catch (err) {
    logger.error('Crypto', 'Buffer decryption failed:', err);
    throw err;
  }
}
