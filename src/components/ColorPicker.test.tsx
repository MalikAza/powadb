import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ColorPicker } from "./ColorPicker";

describe("ColorPicker — preset swatches", () => {
  it("renders one button per preset color plus a custom-color trigger", () => {
    render(<ColorPicker value={null} onChange={() => {}} />);
    // 10 named presets + the "Custom color" popover trigger.
    expect(screen.getByLabelText("none")).toBeDefined();
    expect(screen.getByLabelText("red")).toBeDefined();
    expect(screen.getByLabelText("pink")).toBeDefined();
    expect(screen.getByLabelText("Custom color")).toBeDefined();
  });

  it("clicking a preset fires onChange with that color value", () => {
    const onChange = vi.fn();
    render(<ColorPicker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("red"));
    expect(onChange).toHaveBeenCalledWith("#ef4444");
  });

  it("clicking the 'none' preset fires onChange with null", () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#ef4444" onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("none"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("rings the currently-selected preset", () => {
    render(<ColorPicker value="#22c55e" onChange={() => {}} />);
    expect(screen.getByLabelText("green").className).toContain("ring-2");
    expect(screen.getByLabelText("red").className).not.toContain("ring-2");
  });

  it("rings the custom-color trigger when the value is not one of the presets", () => {
    render(<ColorPicker value="#123456" onChange={() => {}} />);
    expect(screen.getByLabelText("Custom color").className).toContain("ring-2");
    // No preset should also be ringed simultaneously.
    expect(screen.getByLabelText("red").className).not.toContain("ring-2");
  });
});

describe("ColorPicker — custom hex input", () => {
  function openCustomPicker() {
    render(<ColorPicker value="#1a2b3c" onChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Custom color"));
  }

  it("opens the popover and shows the hex input prefilled with the current value", () => {
    openCustomPicker();
    const hex = screen.getByPlaceholderText("#rrggbb") as HTMLInputElement;
    expect(hex.value).toBe("#1a2b3c");
  });

  it("commits a normalized lowercase hex when a valid 6-digit hex is typed", () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#000000" onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Custom color"));
    fireEvent.change(screen.getByPlaceholderText("#rrggbb"), {
      target: { value: "#ABCDEF" },
    });
    expect(onChange).toHaveBeenLastCalledWith("#abcdef");
  });

  it("ignores invalid input (no onChange fired, no crash)", () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#000000" onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Custom color"));
    fireEvent.change(screen.getByPlaceholderText("#rrggbb"), {
      target: { value: "not-a-hex" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts a 6-digit hex without leading '#'", () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#000000" onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Custom color"));
    fireEvent.change(screen.getByPlaceholderText("#rrggbb"), {
      target: { value: "112233" },
    });
    expect(onChange).toHaveBeenLastCalledWith("#112233");
  });
});

describe("ColorPicker — external value updates", () => {
  it("syncs internal state when the parent passes a new value prop", () => {
    const { rerender } = render(<ColorPicker value="#111111" onChange={() => {}} />);
    fireEvent.click(screen.getByLabelText("Custom color"));
    expect((screen.getByPlaceholderText("#rrggbb") as HTMLInputElement).value).toBe("#111111");

    rerender(<ColorPicker value="#222222" onChange={() => {}} />);
    expect((screen.getByPlaceholderText("#rrggbb") as HTMLInputElement).value).toBe("#222222");
  });
});
