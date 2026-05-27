import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CommunityTheme } from "@/lib/communityThemes";
import { type CustomTheme, THEME_TOKENS, type ThemeColors } from "@/lib/themeTokens";
import { CommunityThemeRow, CustomThemeRow, FilterPill, ThemeFilterBar } from "./SettingsDialog";

function makeColors(): ThemeColors {
  return Object.fromEntries(THEME_TOKENS.map((t) => [t, "#abcdef"])) as ThemeColors;
}

function makeCustom(over: Partial<CustomTheme> = {}): CustomTheme {
  return {
    id: "custom-1",
    name: "My Theme",
    base: "dark",
    radius: "0.5rem",
    colors: makeColors(),
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function makeCommunity(over: Partial<CommunityTheme["theme"]> = {}): CommunityTheme {
  return {
    slug: "nord",
    theme: {
      schema: "powadb-theme/v1",
      name: "Nord",
      base: "dark",
      radius: "0.5rem",
      colors: makeColors(),
      ...over,
    },
  };
}

describe("FilterPill", () => {
  it("renders children, calls onClick, and applies the active style when active", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <FilterPill active={false} onClick={onClick}>
        All
      </FilterPill>,
    );
    const btn = screen.getByRole("button", { name: "All" });
    expect(btn.className).not.toContain("bg-primary");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <FilterPill active={true} onClick={onClick}>
        All
      </FilterPill>,
    );
    expect(screen.getByRole("button", { name: "All" }).className).toContain("bg-primary");
  });

  it("renders an optional icon prefix", () => {
    render(
      <FilterPill active={false} onClick={() => {}} icon={<span data-testid="icon" />}>
        Light
      </FilterPill>,
    );
    expect(screen.getByTestId("icon")).toBeDefined();
  });
});

describe("ThemeFilterBar", () => {
  it("forwards typing into the search input", () => {
    const onQueryChange = vi.fn();
    render(
      <ThemeFilterBar
        query=""
        onQueryChange={onQueryChange}
        filter="all"
        onFilterChange={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Search themes…"), {
      target: { value: "nor" },
    });
    expect(onQueryChange).toHaveBeenCalledWith("nor");
  });

  it("invokes onFilterChange with the right token when pills are clicked", () => {
    const onFilterChange = vi.fn();
    render(
      <ThemeFilterBar
        query=""
        onQueryChange={() => {}}
        filter="all"
        onFilterChange={onFilterChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Light/ }));
    fireEvent.click(screen.getByRole("button", { name: /Dark/ }));
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onFilterChange.mock.calls.map((c) => c[0])).toEqual(["light", "dark", "all"]);
  });

  it("marks the currently-selected filter pill as active", () => {
    render(
      <ThemeFilterBar query="" onQueryChange={() => {}} filter="dark" onFilterChange={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /Dark/ }).className).toContain("bg-primary");
    expect(screen.getByRole("button", { name: /Light/ }).className).not.toContain("bg-primary");
  });
});

describe("CommunityThemeRow", () => {
  it("shows the theme name, base, and Install button that fires onInstall", () => {
    const onInstall = vi.fn();
    render(<CommunityThemeRow community={makeCommunity()} onInstall={onInstall} />);

    expect(screen.getByText("Nord")).toBeDefined();
    expect(screen.getByText("dark")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Install/ }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });
});

describe("CustomThemeRow", () => {
  it("renders the Community badge only when fromCommunity is true", () => {
    const props = {
      theme: makeCustom(),
      active: false,
      onSelect: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onExport: vi.fn(),
    };
    const { rerender } = render(<CustomThemeRow {...props} fromCommunity={false} />);
    expect(screen.queryByText("Community")).toBeNull();

    rerender(<CustomThemeRow {...props} fromCommunity={true} />);
    expect(screen.getByText("Community")).toBeDefined();
  });

  it("fires onSelect when the row body is clicked", () => {
    const onSelect = vi.fn();
    render(
      <CustomThemeRow
        theme={makeCustom({ name: "Slate" })}
        active={false}
        fromCommunity={false}
        onSelect={onSelect}
        onEdit={() => {}}
        onDelete={() => {}}
        onExport={() => {}}
      />,
    );
    // The whole left-side button is the selection target; its accessible name is the theme name.
    fireEvent.click(screen.getByRole("button", { name: /Slate/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("applies the active border style when active=true", () => {
    const { container, rerender } = render(
      <CustomThemeRow
        theme={makeCustom()}
        active={false}
        fromCommunity={false}
        onSelect={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onExport={() => {}}
      />,
    );
    expect(container.firstElementChild?.className).not.toContain("border-primary");

    rerender(
      <CustomThemeRow
        theme={makeCustom()}
        active={true}
        fromCommunity={false}
        onSelect={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onExport={() => {}}
      />,
    );
    expect(container.firstElementChild?.className).toContain("border-primary");
  });
});
