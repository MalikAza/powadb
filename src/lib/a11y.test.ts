import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { onActivateKey } from "./a11y";

function fakeEvent(key: string): KeyboardEvent<HTMLElement> {
  const preventDefault = vi.fn();
  return { key, preventDefault } as unknown as KeyboardEvent<HTMLElement>;
}

describe("onActivateKey", () => {
  it("fires the handler on Enter and prevents default", () => {
    const handler = vi.fn();
    const e = fakeEvent("Enter");
    onActivateKey(handler)(e);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("fires the handler on Space and prevents default", () => {
    const handler = vi.fn();
    const e = fakeEvent(" ");
    onActivateKey(handler)(e);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys without preventing default", () => {
    const handler = vi.fn();
    for (const key of ["a", "Tab", "Escape", "ArrowDown", "Spacebar"]) {
      const e = fakeEvent(key);
      onActivateKey(handler)(e);
      expect(handler).not.toHaveBeenCalled();
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("returns a fresh handler closure per call so each binds its own callback", () => {
    const a = vi.fn();
    const b = vi.fn();
    onActivateKey(a)(fakeEvent("Enter"));
    onActivateKey(b)(fakeEvent("Enter"));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
