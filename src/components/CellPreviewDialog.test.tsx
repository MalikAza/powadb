import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CellPreviewDialog } from "./CellPreviewDialog";

function renderDialog(preview: Parameters<typeof CellPreviewDialog>[0]["preview"]) {
  return render(<CellPreviewDialog preview={preview} onOpenChange={() => {}} />);
}

describe("CellPreviewDialog — rendered text", () => {
  it("falls back to String(value) when no displayValue is provided", () => {
    renderDialog({ columnName: "id", value: "\\xDEADBEEF" });
    expect(screen.getByText("\\xDEADBEEF")).toBeDefined();
  });

  it("renders 'NULL' for null / undefined values", () => {
    renderDialog({ columnName: "name", value: null });
    expect(screen.getByText("NULL")).toBeDefined();
  });

  it("pretty-prints object values as JSON", () => {
    renderDialog({ columnName: "meta", value: { a: 1, b: [2, 3] } });
    expect(screen.getByText(/"a": 1/)).toBeDefined();
    expect(screen.getByText(/"b": \[/)).toBeDefined();
  });

  it("uses displayValue verbatim when provided (ULID-formatted BYTEA)", () => {
    renderDialog({
      columnName: "user_id",
      value: "\\x01H8K4QZP9V3KX1F7R6N2T8WJC9",
      displayValue: "01H8K4QZP9V3KX1F7R6N2T8WJC9",
    });
    expect(screen.getByText("01H8K4QZP9V3KX1F7R6N2T8WJC9")).toBeDefined();
    // Raw hex value must not also appear in the preview body.
    expect(screen.queryByText("\\x01H8K4QZP9V3KX1F7R6N2T8WJC9")).toBeNull();
  });

  it("displayValue takes precedence even when value is null", () => {
    renderDialog({ columnName: "x", value: null, displayValue: "fallback-shown" });
    expect(screen.getByText("fallback-shown")).toBeDefined();
    expect(screen.queryByText("NULL")).toBeNull();
  });
});

describe("CellPreviewDialog — copy button", () => {
  function setupClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  }

  it("copies the raw stringified value when no displayValue is set", () => {
    const writeText = setupClipboard();
    renderDialog({ columnName: "id", value: "raw-hex" });
    fireEvent.click(screen.getByText("Copy"));
    expect(writeText).toHaveBeenCalledWith("raw-hex");
  });

  it("copies the displayValue (ULID/UUID/hex) when provided", () => {
    const writeText = setupClipboard();
    renderDialog({
      columnName: "id",
      value: "\\xDEADBEEFCAFEBABE0011223344556677",
      displayValue: "DEADBEEF-CAFE-BABE-0011-223344556677",
    });
    fireEvent.click(screen.getByText("Copy"));
    expect(writeText).toHaveBeenCalledWith("DEADBEEF-CAFE-BABE-0011-223344556677");
  });
});
