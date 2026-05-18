// Helpers for the BYTEA display modes (ULID / UUID) used by the browse grid.
//
// Backend BYTEA columns arrive as `\x<UPPER HEX>` strings (see decode_pg in
// drivers/postgres.rs). For 16-byte values we let the user opt into rendering
// them as ULID (Crockford 26-char) or UUID (canonical 8-4-4-4-12). Edits go
// back through hex; the SQL path binds the hex as text and decodes server-side
// via `decode($1, 'hex')::bytea`.

export type ByteaDisplayMode = "hex" | "ulid" | "uuid";

/** Strip a leading `\x` (the Postgres BYTEA literal prefix) if present. */
export function stripHexPrefix(hex: string): string {
  return hex.startsWith("\\x") ? hex.slice(2) : hex;
}

/** Length of the decoded byte string (in bytes) for a hex literal. */
export function hexByteLength(hex: string): number {
  const s = stripHexPrefix(hex);
  return Math.floor(s.length / 2);
}

function hexToBytes(hex: string): Uint8Array | null {
  const s = stripHexPrefix(hex);
  if (s.length % 2 !== 0) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseHexDigit(s.charCodeAt(i * 2));
    const lo = parseHexDigit(s.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function parseHexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0").toUpperCase();
  }
  return s;
}

// UUID — RFC 4122 canonical form (8-4-4-4-12, lowercase).
export function bytesToUuid(bytes: Uint8Array): string | null {
  if (bytes.length !== 16) return null;
  const h = bytesToHex(bytes).toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function uuidToHex(uuid: string): string | null {
  const stripped = uuid.replace(/-/g, "").trim();
  if (stripped.length !== 32) return null;
  if (!/^[0-9a-fA-F]+$/.test(stripped)) return null;
  return stripped.toUpperCase();
}

// ULID — Crockford base32 (no I, L, O, U), big-endian over the 16 raw bytes.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// Decoder: index by char code; -1 for invalid. Includes lowercase aliases.
const CROCKFORD_DECODE: Int8Array = (() => {
  const arr = new Int8Array(128).fill(-1);
  for (let i = 0; i < CROCKFORD.length; i++) {
    const c = CROCKFORD.charCodeAt(i);
    arr[c] = i;
    arr[c >= 65 && c <= 90 ? c + 32 : c] = i; // lowercase alias
  }
  // Crockford ambiguity tolerances: I/L → 1, O → 0.
  arr["I".charCodeAt(0)] = 1;
  arr["i".charCodeAt(0)] = 1;
  arr["L".charCodeAt(0)] = 1;
  arr["l".charCodeAt(0)] = 1;
  arr["O".charCodeAt(0)] = 0;
  arr["o".charCodeAt(0)] = 0;
  return arr;
})();

/** Encode 16 raw bytes as a 26-char Crockford base32 ULID. */
export function bytesToUlid(bytes: Uint8Array): string | null {
  if (bytes.length !== 16) return null;
  // 16 bytes = 128 bits. ULID layout: first char encodes only the top 3 bits
  // (the high 5 are always zero in the canonical form), the remaining 25
  // chars encode 125 bits — total 128.
  const out = new Array<string>(26);
  // High char: top 3 bits of byte 0.
  out[0] = CROCKFORD[(bytes[0] & 0xe0) >> 5];
  // Walk a bit cursor through the remaining 125 bits.
  // Start at bit position 3 (after the 3 high bits already consumed).
  let bitPos = 3;
  for (let i = 1; i < 26; i++) {
    const byteIdx = Math.floor(bitPos / 8);
    const bitOff = bitPos % 8;
    let v: number;
    if (bitOff <= 3) {
      v = (bytes[byteIdx] >> (3 - bitOff)) & 0x1f;
    } else {
      const high = (bytes[byteIdx] & ((1 << (8 - bitOff)) - 1)) << (bitOff - 3);
      const low = bytes[byteIdx + 1] >> (8 - (bitOff - 3));
      v = (high | low) & 0x1f;
    }
    out[i] = CROCKFORD[v];
    bitPos += 5;
  }
  return out.join("");
}

/** Decode a 26-char Crockford ULID back to its 32-char upper-case hex. */
export function ulidToHex(ulid: string): string | null {
  const s = ulid.trim();
  if (s.length !== 26) return null;
  // First char must encode only 3 valid bits (top 5 must be zero).
  const first = CROCKFORD_DECODE[s.charCodeAt(0)];
  if (first < 0 || first > 7) return null;
  const bytes = new Uint8Array(16);
  // Accumulate into a bit buffer.
  let acc = first;
  let bits = 3;
  let outIdx = 0;
  for (let i = 1; i < 26; i++) {
    const v = CROCKFORD_DECODE[s.charCodeAt(i)];
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes[outIdx++] = (acc >> bits) & 0xff;
    }
  }
  if (outIdx !== 16) return null;
  return bytesToHex(bytes);
}

/** Format a `\xHEX` BYTEA value according to a display mode. Returns null if
 *  the requested mode doesn't apply (wrong length, malformed hex). */
export function formatBytea(raw: string, mode: ByteaDisplayMode): string | null {
  if (mode === "hex") return raw;
  const bytes = hexToBytes(raw);
  if (!bytes) return null;
  if (mode === "uuid") return bytesToUuid(bytes);
  return bytesToUlid(bytes);
}

/** Parse user-typed display value back to bare upper-hex (no `\x` prefix).
 *  Returns null on invalid input. */
export function parseByteaInput(input: string, mode: ByteaDisplayMode): string | null {
  const trimmed = input.trim();
  if (mode === "uuid") return uuidToHex(trimmed);
  if (mode === "ulid") return ulidToHex(trimmed);
  // hex mode: allow optional \x prefix, validate.
  const stripped = stripHexPrefix(trimmed);
  if (stripped.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]*$/.test(stripped)) return null;
  return stripped.toUpperCase();
}
