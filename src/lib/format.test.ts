import { describe, expect, it } from "vitest";
import { formatBytes } from "./format";

describe("formatBytes", () => {
  it("keeps raw bytes below 1024", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("uses one decimal under 10 units, none above", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(512 * 1024)).toBe("512 KB");
  });

  it("walks the unit ladder up to TB", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TB");
    // TB is the cap: values past it stay in TB.
    expect(formatBytes(5000 * 1024 ** 4)).toBe("5000 TB");
  });
});
