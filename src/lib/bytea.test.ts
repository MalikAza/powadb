import { describe, expect, it } from "vitest";
import {
  bytesToUlid,
  bytesToUuid,
  formatBytea,
  parseByteaInput,
  stripHexPrefix,
  ulidToHex,
  uuidToHex,
} from "./bytea";

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe("stripHexPrefix", () => {
  it("removes leading backslash-x", () => {
    expect(stripHexPrefix("\\xABCD")).toBe("ABCD");
    expect(stripHexPrefix("ABCD")).toBe("ABCD");
  });
});

describe("UUID", () => {
  it("round-trips canonical bytes", () => {
    const hex = "550E8400E29B41D4A716446655440000";
    const uuid = bytesToUuid(hexBytes(hex));
    expect(uuid).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(uuidToHex(uuid as string)).toBe(hex);
  });

  it("rejects malformed input", () => {
    expect(uuidToHex("not-a-uuid")).toBeNull();
    expect(uuidToHex("550e8400-e29b-41d4-a716-44665544000")).toBeNull();
  });
});

describe("ULID", () => {
  // Reference vector from the ULID spec: timestamp 0x01ARYZ6S41 + 80 zero bits.
  // The classic test vector "01ARYZ6S41TSV4RRFFQ69G5FAV" decodes to known bytes
  // — we use a deterministic round-trip to validate our implementation.
  it("round-trips zero bytes", () => {
    const zero = new Uint8Array(16);
    const ulid = bytesToUlid(zero);
    expect(ulid).toBe("00000000000000000000000000");
    expect(ulidToHex(ulid as string)).toBe("00000000000000000000000000000000");
  });

  it("round-trips max bytes", () => {
    const max = new Uint8Array(16).fill(0xff);
    const ulid = bytesToUlid(max);
    expect(ulid).toBe("7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(ulidToHex(ulid as string)).toBe("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
  });

  it("round-trips an arbitrary value", () => {
    const hex = "0192C8D9F0FA2F4E8B7AC6D5E4F312AB";
    const ulid = bytesToUlid(hexBytes(hex));
    expect(ulid).not.toBeNull();
    expect(ulidToHex(ulid as string)).toBe(hex);
  });

  it("tolerates Crockford ambiguity (I/L→1, O→0)", () => {
    const ulid = bytesToUlid(new Uint8Array(16)); // "00000000000000000000000000"
    // Substitute O for 0 and L for 1 — should still decode to all zeros.
    const munged = ulid?.replace(/0/g, "O") ?? "";
    expect(ulidToHex(munged)).toBe("00000000000000000000000000000000");
  });

  it("rejects wrong length", () => {
    expect(ulidToHex("TOOSHORT")).toBeNull();
  });

  it("rejects overflowing first character", () => {
    // Any first char > '7' would represent more than 3 bits → invalid.
    expect(ulidToHex("8ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBeNull();
  });
});

describe("formatBytea / parseByteaInput", () => {
  it("hex mode is identity-ish", () => {
    expect(formatBytea("\\xDEADBEEF", "hex")).toBe("\\xDEADBEEF");
    expect(parseByteaInput("\\xdeadbeef", "hex")).toBe("DEADBEEF");
  });

  it("uuid mode round-trips through the displayed form", () => {
    const raw = "\\x550E8400E29B41D4A716446655440000";
    const shown = formatBytea(raw, "uuid");
    expect(shown).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(parseByteaInput(shown as string, "uuid")).toBe("550E8400E29B41D4A716446655440000");
  });

  it("ulid mode round-trips through the displayed form", () => {
    const raw = "\\x0192C8D9F0FA2F4E8B7AC6D5E4F312AB";
    const shown = formatBytea(raw, "ulid");
    expect(shown).not.toBeNull();
    expect(parseByteaInput(shown as string, "ulid")).toBe("0192C8D9F0FA2F4E8B7AC6D5E4F312AB");
  });

  it("returns null when bytes don't match mode length", () => {
    expect(formatBytea("\\xDEADBEEF", "uuid")).toBeNull();
    expect(formatBytea("\\xDEADBEEF", "ulid")).toBeNull();
  });
});
