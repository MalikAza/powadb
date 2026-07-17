import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowseTab } from "@/stores/tabs";
import { useTabs } from "@/stores/tabs";
import type { QueryResult, SavedConnection } from "@/types";
import { BrowseHeader } from "./BrowseHeader";

function makeBrowseTab(over: Partial<BrowseTab> = {}): BrowseTab {
  return {
    id: "t1",
    connectionId: "c1",
    kind: "browse",
    title: "users",
    schema: "public",
    table: "users",
    filters: {},
    sortCol: null,
    sortDir: "asc",
    limit: 100,
    offset: 0,
    pkCols: null,
    totalRows: null,
    result: null,
    error: null,
    loading: false,
    ...over,
  };
}

function resultWithRows(n: number): QueryResult {
  return { columns: [], rows: Array.from({ length: n }, () => []), elapsed_ms: 0 };
}

function makeConn(kind: SavedConnection["kind"]): SavedConnection {
  return {
    id: "c1",
    name: "c",
    kind,
    host: "h",
    port: 5432,
    database: "d",
    username: "u",
    ssl: false,
    folder_id: null,
    color: null,
    position: null,
    wg: null,
    ssh: null,
  };
}

// [refresh, prev, next] — the shadcn SelectTrigger is role="combobox", not "button".
function paginationButtons() {
  const buttons = screen.getAllByRole("button");
  return { refresh: buttons[0], prev: buttons[1], next: buttons[2] };
}

beforeEach(() => {
  useTabs.setState({ tabs: [], activeTabId: null });
});

describe("BrowseHeader", () => {
  it("shows the schema prefix for postgres connections", () => {
    render(<BrowseHeader tab={makeBrowseTab()} conn={makeConn("postgres")} onRefresh={() => {}} />);
    expect(screen.getByText("public.")).toBeDefined();
    expect(screen.getByText("users")).toBeDefined();
  });

  it("omits the schema prefix for non-postgres connections", () => {
    render(<BrowseHeader tab={makeBrowseTab()} conn={makeConn("mysql")} onRefresh={() => {}} />);
    expect(screen.queryByText("public.")).toBeNull();
    expect(screen.getByText("users")).toBeDefined();
  });

  it("renders the current row range from offset and result length", () => {
    const tab = makeBrowseTab({ offset: 200, result: resultWithRows(50) });
    render(<BrowseHeader tab={tab} conn={makeConn("postgres")} onRefresh={() => {}} />);
    expect(screen.getByText("201–250")).toBeDefined();
  });

  it("renders an em dash when there are no rows", () => {
    render(<BrowseHeader tab={makeBrowseTab()} conn={makeConn("postgres")} onRefresh={() => {}} />);
    expect(screen.getByText("—")).toBeDefined();
  });

  it("disables Previous at the first page and Next when there is no full page", () => {
    // offset 0 → no previous; 50 rows < limit 100 → no next.
    const tab = makeBrowseTab({ offset: 0, limit: 100, result: resultWithRows(50) });
    render(<BrowseHeader tab={tab} conn={makeConn("postgres")} onRefresh={() => {}} />);
    const { prev, next } = paginationButtons();
    expect((prev as HTMLButtonElement).disabled).toBe(true);
    expect((next as HTMLButtonElement).disabled).toBe(true);
  });

  it("advances the offset by one page when Next is clicked", () => {
    // A full page (rows === limit) enables Next.
    const tab = makeBrowseTab({ offset: 0, limit: 100, result: resultWithRows(100) });
    useTabs.setState({ tabs: [tab], activeTabId: tab.id });
    render(<BrowseHeader tab={tab} conn={makeConn("postgres")} onRefresh={() => {}} />);

    fireEvent.click(paginationButtons().next);
    const updated = useTabs.getState().tabs[0];
    if (updated.kind !== "browse") throw new Error("expected browse tab");
    expect(updated.offset).toBe(100);
  });

  it("steps back a page (clamped at zero) when Previous is clicked", () => {
    const tab = makeBrowseTab({ offset: 100, limit: 100, result: resultWithRows(100) });
    useTabs.setState({ tabs: [tab], activeTabId: tab.id });
    render(<BrowseHeader tab={tab} conn={makeConn("postgres")} onRefresh={() => {}} />);

    fireEvent.click(paginationButtons().prev);
    const updated = useTabs.getState().tabs[0];
    if (updated.kind !== "browse") throw new Error("expected browse tab");
    expect(updated.offset).toBe(0);
  });

  it("invokes onRefresh when the refresh button is clicked", () => {
    const onRefresh = vi.fn();
    render(
      <BrowseHeader tab={makeBrowseTab()} conn={makeConn("postgres")} onRefresh={onRefresh} />,
    );
    fireEvent.click(paginationButtons().refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
