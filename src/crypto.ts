import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// ─── Versioned wire format ────────────────────────────────────────────────────
//
// New  : MAGIC(2) + KID(1) + IV(12) + TAG(16) + CIPHERTEXT  — 31+ bytes
// Legacy: IV(12)  +          TAG(16) + CIPHERTEXT            — 28+ bytes
//
// Magic = 0x63 0x62 ("cb" — chatbox). Probability that a legacy IV starts with
// these exact two bytes is 1/65 536 ≈ 0.0015 %, making false-positive detection
// effectively impossible.

const MAGIC = Buffer.from([0x63, 0x62]);
const MAGIC_LEN = 2;
const KID_LEN = 1;
// Minimum byte count that unambiguously identifies the versioned format
const NEW_FORMAT_MIN = MAGIC_LEN + KID_LEN + IV_LENGTH + TAG_LENGTH; // 31

// ─── Key management ───────────────────────────────────────────────────────────
//
// Two ways to supply keys:
//   1. FIELD_ENCRYPTION_KEY=<base64-32-bytes>   — legacy, always treated as kid=0
//   2. ENCRYPTION_KEYS='{"0":"<b64>","1":"<b64>"}' — multi-key map (overrides kid=0)
//      ENCRYPTION_CURRENT_KID=1                 — which kid to use for new writes
//
// During key rotation:
//   a. Add new key to ENCRYPTION_KEYS with a new kid (e.g. "1": "...")
//   b. Set ENCRYPTION_CURRENT_KID to the new kid
//   c. New writes use the new key; existing ciphertext is still readable
//   d. Run the re-encryption job (POST /admin/crypto/reencrypt) to migrate old data

function buildKeyMap(): Map<number, Buffer> {
  const map = new Map<number, Buffer>();

  const keysJson = process.env.ENCRYPTION_KEYS;
  if (keysJson) {
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(keysJson) as Record<string, string>;
    } catch {
      throw new Error('ENCRYPTION_KEYS must be valid JSON: {"0":"base64key","1":"base64key"}');
    }
    for (const [kidStr, b64] of Object.entries(parsed)) {
      const kid = Number(kidStr);
      if (!Number.isInteger(kid) || kid < 0 || kid > 255) {
        throw new Error(`ENCRYPTION_KEYS: invalid kid "${kidStr}" — must be 0-255`);
      }
      const key = Buffer.from(b64, 'base64');
      if (key.length !== 32) throw new Error(`ENCRYPTION_KEYS: key for kid=${kid} must be 32 bytes (base64)`);
      map.set(kid, key);
    }
  }

  // FIELD_ENCRYPTION_KEY is the legacy single-key path, always kid=0
  const legacy = process.env.FIELD_ENCRYPTION_KEY;
  if (legacy && !map.has(0)) {
    const key = Buffer.from(legacy, 'base64');
    if (key.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be 32 bytes (base64-encoded)');
    map.set(0, key);
  }

  if (map.size === 0) {
    throw new Error('No encryption key configured. Set FIELD_ENCRYPTION_KEY or ENCRYPTION_KEYS.');
  }

  return map;
}

// Lazily built — avoids requiring env vars at module load time
let _keyMap: Map<number, Buffer> | null = null;

function getKeyMap(): Map<number, Buffer> {
  if (!_keyMap) _keyMap = buildKeyMap();
  return _keyMap;
}

function getCurrentKid(): number {
  const val = process.env.ENCRYPTION_CURRENT_KID;
  if (!val) return 0;
  const kid = Number(val);
  if (!Number.isInteger(kid) || kid < 0 || kid > 255) {
    throw new Error('ENCRYPTION_CURRENT_KID must be an integer 0-255');
  }
  return kid;
}

function getKeyByKid(kid: number): Buffer {
  const key = getKeyMap().get(kid);
  if (!key) throw new Error(`No encryption key configured for kid=${kid}. Add it to ENCRYPTION_KEYS.`);
  return key;
}

/** Returns the set of kid values that have a configured key. */
export function availableKids(): number[] {
  return [...getKeyMap().keys()].sort((a, b) => a - b);
}

/** Reset the key map cache — call after env vars change (e.g. in tests or key rotation). */
export function resetKeyCache(): void {
  _keyMap = null;
}

// ─── AES-256-GCM core ─────────────────────────────────────────────────────────

function aesEncrypt(key: Buffer, plaintext: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function aesDecrypt(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Encrypt plaintext using the current key (ENCRYPTION_CURRENT_KID).
 * Output: MAGIC(2) + KID(1) + IV(12) + TAG(16) + CIPHERTEXT
 */
export function encrypt(plaintext: string): Buffer {
  const kid = getCurrentKid();
  const key = getKeyByKid(kid);
  const { iv, tag, ciphertext } = aesEncrypt(key, plaintext);
  return Buffer.concat([MAGIC, Buffer.from([kid]), iv, tag, ciphertext]);
}

/**
 * Decrypt a buffer produced by this module.
 * Handles both the versioned format (MAGIC+KID prefix) and the legacy format
 * (raw IV+TAG+CIPHERTEXT, always decrypted with kid=0).
 */
export function decrypt(data: Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

  const isVersioned =
    buf.length >= NEW_FORMAT_MIN &&
    buf[0] === MAGIC[0] &&
    buf[1] === MAGIC[1];

  if (isVersioned) {
    const kid = buf[MAGIC_LEN];
    const key = getKeyByKid(kid);
    const base = MAGIC_LEN + KID_LEN;
    const iv = buf.subarray(base, base + IV_LENGTH);
    const tag = buf.subarray(base + IV_LENGTH, base + IV_LENGTH + TAG_LENGTH);
    const ciphertext = buf.subarray(base + IV_LENGTH + TAG_LENGTH);
    return aesDecrypt(key, iv, tag, ciphertext);
  }

  // Legacy format — IV(12) + TAG(16) + CIPHERTEXT, always kid=0
  const key = getKeyByKid(0);
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  return aesDecrypt(key, iv, tag, ciphertext);
}

export function encryptJson(obj: unknown): Buffer {
  return encrypt(JSON.stringify(obj));
}

export function decryptJson<T = unknown>(data: Buffer | Uint8Array): T {
  return JSON.parse(decrypt(data)) as T;
}

/**
 * Encrypt a string and return a base64-encoded string — useful for
 * JSON-serializable contexts such as BullMQ job payloads stored in Redis.
 */
export function encryptToBase64(plaintext: string): string {
  return encrypt(plaintext).toString('base64');
}

/** Inverse of encryptToBase64. */
export function decryptFromBase64(b64: string): string {
  return decrypt(Buffer.from(b64, 'base64'));
}

/**
 * Read the KID stored in an encrypted blob without fully decrypting it.
 * Returns 0 for legacy-format blobs (no KID header).
 * Used by the re-encryption endpoint to skip blobs already on the current KID.
 */
export function getStoredKid(data: Buffer | Uint8Array): number {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (
    buf.length >= NEW_FORMAT_MIN &&
    buf[0] === MAGIC[0] &&
    buf[1] === MAGIC[1]
  ) {
    return buf[MAGIC_LEN];
  }
  return 0; // legacy format — treated as KID 0
}
