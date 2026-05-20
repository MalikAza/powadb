import type { Column } from "@/types";

const CHAR_PX = 7;
const PADDING_PX = 28;
export const MIN_AUTO_WIDTH_PX = 120;
export const MAX_AUTO_WIDTH_PX = 280;

/**
 * Compute a sensible default pixel width per column from header text and the
 * stringified content of the visible rows. Used to seed `useColumnResize`.
 *
 * Both `ResultsGrid` (custom queries) and `BrowseTabPane` (browse data) start
 * from the same auto-sizing so the default look is consistent across the app.
 */
export function measureColumnWidths(columns: Column[], rows: readonly (readonly unknown[])[]) {
  const cap = Math.ceil((MAX_AUTO_WIDTH_PX - PADDING_PX) / CHAR_PX);
  return columns.map((c, colIdx) => {
    let maxChars = Math.max(c.name.length, c.type_name.length);
    for (const row of rows) {
      const v = row[colIdx];
      const s =
        v === null || v === undefined
          ? "NULL"
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
      if (s.length > maxChars) maxChars = s.length;
      if (maxChars >= cap) break;
    }
    const px = maxChars * CHAR_PX + PADDING_PX;
    return Math.min(MAX_AUTO_WIDTH_PX, Math.max(MIN_AUTO_WIDTH_PX, px));
  });
}
