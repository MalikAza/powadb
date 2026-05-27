import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESIZE_MAX_PX, RESIZE_MIN_PX, useColumnResize } from "./useColumnResize";

type Listener = (ev: PointerEvent) => void;

function makeMockTarget(): {
  el: HTMLElement;
  listeners: Map<string, Listener[]>;
  fire: (type: string, ev: PointerEvent) => void;
  setPointerCapture: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, Listener[]>();
  const el = document.createElement("th");
  const setPointerCapture = vi.fn();
  (el as unknown as { setPointerCapture: typeof setPointerCapture }).setPointerCapture =
    setPointerCapture;
  el.addEventListener = vi.fn((type: string, cb: EventListenerOrEventListenerObject) => {
    const list = listeners.get(type) ?? [];
    list.push(cb as Listener);
    listeners.set(type, list);
  });
  el.removeEventListener = vi.fn((type: string, cb: EventListenerOrEventListenerObject) => {
    const list = listeners.get(type) ?? [];
    listeners.set(
      type,
      list.filter((l) => l !== (cb as Listener)),
    );
  });
  return {
    el,
    listeners,
    setPointerCapture,
    fire: (type, ev) => {
      // The hook attaches to BOTH the target element and window. We fire on the
      // captured-element handlers; the window listeners get the real event below.
      for (const cb of listeners.get(type) ?? []) cb(ev);
    },
  };
}

function pointerEvent(clientX: number): PointerEvent {
  // jsdom doesn't ship a real PointerEvent constructor that round-trips
  // clientX/clientY, so we hand-build a plain object the hook can read.
  return { clientX, pointerId: 1 } as unknown as PointerEvent;
}

function startEvent(target: HTMLElement, clientX: number) {
  return {
    clientX,
    pointerId: 1,
    currentTarget: target,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.PointerEvent;
}

beforeEach(() => {
  document.body.classList.remove("col-resizing");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The hook re-syncs widths whenever the identity of `initialWidths` changes,
// so all renderHook callers must close over a stable array reference (real
// callers memoize via useMemo).
const INIT_1 = [100];
const INIT_2 = [100, 200];
const INIT_3 = [100, 200, 300];

describe("useColumnResize basic state", () => {
  it("initializes widths from the provided initialWidths", () => {
    const { result } = renderHook(() => useColumnResize(INIT_3));
    expect(result.current.widths).toEqual([100, 200, 300]);
  });

  it("re-syncs widths when initialWidths identity changes", () => {
    const A = [100, 200];
    const B = [50, 75];
    const { result, rerender } = renderHook(({ w }) => useColumnResize(w), {
      initialProps: { w: A },
    });
    expect(result.current.widths).toEqual([100, 200]);
    rerender({ w: B });
    expect(result.current.widths).toEqual([50, 75]);
  });
});

describe("useColumnResize startResize", () => {
  it("adds the col-resizing body class on start and removes it on pointerup", () => {
    const { result } = renderHook(() => useColumnResize(INIT_1));
    const t = makeMockTarget();
    act(() => {
      result.current.startResize(0, startEvent(t.el, 0));
    });
    expect(document.body.classList.contains("col-resizing")).toBe(true);
    act(() => {
      t.fire("pointerup", pointerEvent(0));
    });
    expect(document.body.classList.contains("col-resizing")).toBe(false);
  });

  it("captures the pointer (and swallows errors when capture is already held)", () => {
    const { result } = renderHook(() => useColumnResize(INIT_1));
    const t = makeMockTarget();
    t.setPointerCapture.mockImplementation(() => {
      throw new Error("already captured");
    });
    expect(() => {
      act(() => {
        result.current.startResize(0, startEvent(t.el, 0));
      });
    }).not.toThrow();
    expect(t.setPointerCapture).toHaveBeenCalledWith(1);
  });

  it("updates widths in stateful mode and clamps to MIN/MAX", () => {
    const { result } = renderHook(() => useColumnResize(INIT_1));
    const t = makeMockTarget();
    act(() => {
      result.current.startResize(0, startEvent(t.el, 0));
    });
    // Drag far left: should clamp to RESIZE_MIN_PX.
    act(() => {
      t.fire("pointermove", pointerEvent(-9999));
    });
    expect(result.current.widths[0]).toBe(RESIZE_MIN_PX);

    // Drag far right: should clamp to RESIZE_MAX_PX.
    act(() => {
      t.fire("pointermove", pointerEvent(9999));
    });
    expect(result.current.widths[0]).toBe(RESIZE_MAX_PX);
  });

  it("fires onCommit with the final width on pointerup", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useColumnResize(INIT_1, { onCommit }));
    const t = makeMockTarget();
    act(() => {
      result.current.startResize(0, startEvent(t.el, 0));
    });
    act(() => {
      t.fire("pointermove", pointerEvent(50));
    });
    act(() => {
      t.fire("pointerup", pointerEvent(50));
    });
    expect(onCommit).toHaveBeenCalledWith(0, 150);
  });

  it("in onLiveResize mode, defers state updates until pointerup", () => {
    const onLiveResize = vi.fn();
    const onCommit = vi.fn();
    const { result } = renderHook(() => useColumnResize(INIT_1, { onLiveResize, onCommit }));
    const t = makeMockTarget();
    act(() => {
      result.current.startResize(0, startEvent(t.el, 0));
    });
    act(() => {
      t.fire("pointermove", pointerEvent(50));
    });
    // State stays unchanged during the drag.
    expect(result.current.widths[0]).toBe(100);
    expect(onLiveResize).toHaveBeenCalledWith(0, 150);

    act(() => {
      t.fire("pointerup", pointerEvent(50));
    });
    // Final width committed on release.
    expect(result.current.widths[0]).toBe(150);
    expect(onCommit).toHaveBeenCalledWith(0, 150);
  });

  it("treats pointercancel like pointerup for cleanup", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useColumnResize(INIT_1, { onCommit }));
    const t = makeMockTarget();
    act(() => {
      result.current.startResize(0, startEvent(t.el, 0));
    });
    act(() => {
      t.fire("pointermove", pointerEvent(20));
    });
    act(() => {
      t.fire("pointercancel", pointerEvent(20));
    });
    expect(document.body.classList.contains("col-resizing")).toBe(false);
    expect(onCommit).toHaveBeenCalled();
  });
});

describe("useColumnResize resetWidth", () => {
  it("reverts the column to the initial width and fires onCommit", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useColumnResize(INIT_2, { onCommit }));
    const t = makeMockTarget();
    act(() => {
      result.current.startResize(0, startEvent(t.el, 0));
    });
    act(() => {
      t.fire("pointermove", pointerEvent(60));
    });
    act(() => {
      t.fire("pointerup", pointerEvent(60));
    });
    expect(result.current.widths[0]).toBe(160);

    act(() => {
      result.current.resetWidth(0);
    });
    expect(result.current.widths[0]).toBe(100);
    expect(onCommit).toHaveBeenLastCalledWith(0, 100);
  });

  it("prefers resetWidths over initialWidths when provided", () => {
    const onReset = vi.fn();
    const RESET_WIDTHS = [222];
    const { result } = renderHook(() =>
      useColumnResize(INIT_1, { resetWidths: RESET_WIDTHS, onReset }),
    );
    act(() => {
      result.current.resetWidth(0);
    });
    expect(result.current.widths[0]).toBe(222);
    expect(onReset).toHaveBeenCalledWith(0, 222);
  });

  it("is a no-op when the target index is out of range", () => {
    const { result } = renderHook(() => useColumnResize(INIT_1));
    act(() => {
      result.current.resetWidth(99);
    });
    expect(result.current.widths).toEqual([100]);
  });

  it("in live-resize mode, paints imperatively first and defers React state", async () => {
    vi.useFakeTimers();
    const onLiveResize = vi.fn();
    const onCommit = vi.fn();
    const RESET_WIDTHS = [180];
    const { result } = renderHook(() =>
      useColumnResize(INIT_1, { onLiveResize, onCommit, resetWidths: RESET_WIDTHS }),
    );
    act(() => {
      result.current.resetWidth(0);
    });
    expect(onLiveResize).toHaveBeenCalledWith(0, 180);
    // State has NOT updated yet — it's queued behind setTimeout(0).
    expect(result.current.widths[0]).toBe(100);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.widths[0]).toBe(180);
    expect(onCommit).toHaveBeenCalledWith(0, 180);
    vi.useRealTimers();
  });
});
