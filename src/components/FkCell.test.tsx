import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FkCell } from "./FkCell";

describe("FkCell", () => {
  it("renders a primitive value as-is and opens on click", () => {
    const onOpen = vi.fn();
    render(
      <FkCell
        value={42}
        target="public.authors"
        onOpen={onOpen}
        onEdit={null}
        onShowFull={() => {}}
      />,
    );
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("42");
    expect(button.getAttribute("title")).toBe("Open referenced row in public.authors");
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("stringifies object values", () => {
    render(
      <FkCell
        value={{ id: 1 }}
        target="public.t"
        onOpen={() => {}}
        onEdit={null}
        onShowFull={() => {}}
      />,
    );
    expect(screen.getByRole("button").textContent).toContain('{"id":1}');
  });

  it("shows the Edit item in the context menu only when onEdit is provided", () => {
    const onEdit = vi.fn();
    const { rerender } = render(
      <FkCell
        value="x"
        target="public.t"
        onOpen={() => {}}
        onEdit={onEdit}
        onShowFull={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button"));
    expect(screen.getByText("Edit cell")).toBeDefined();

    rerender(
      <FkCell value="x" target="public.t" onOpen={() => {}} onEdit={null} onShowFull={() => {}} />,
    );
    expect(screen.queryByText("Edit cell")).toBeNull();
  });
});
