import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type BrowseTab, useTabs } from "@/stores/tabs";
import type { SavedConnection } from "@/types";

export function BrowseHeader({
  tab,
  conn,
  onRefresh,
}: {
  tab: BrowseTab;
  conn: SavedConnection;
  onRefresh: () => void;
}) {
  const patchTab = useTabs((s) => s.patchTab);
  const rowCount = tab.result?.rows.length ?? 0;
  const startRow = tab.offset + (rowCount > 0 ? 1 : 0);
  const endRow = tab.offset + rowCount;
  const hasMore = rowCount === tab.limit;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-sm">
        {conn.kind === "postgres" && <span className="text-muted-foreground">{tab.schema}.</span>}
        <span className="font-semibold">{tab.table}</span>
      </span>

      <Button size="sm" variant="ghost" onClick={onRefresh} disabled={tab.loading}>
        <RefreshCw className={tab.loading ? "size-3.5 animate-spin" : "size-3.5"} />
      </Button>

      <div className="ml-auto flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Limit</span>
        <Select
          value={String(tab.limit)}
          onValueChange={(v) => patchTab(tab.id, { limit: Number(v), offset: 0 })}
        >
          <SelectTrigger className="h-7 w-20 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="100">100</SelectItem>
            <SelectItem value="500">500</SelectItem>
            <SelectItem value="1000">1000</SelectItem>
            <SelectItem value="5000">5000</SelectItem>
          </SelectContent>
        </Select>

        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          disabled={tab.offset === 0 || tab.loading}
          onClick={() => patchTab(tab.id, { offset: Math.max(0, tab.offset - tab.limit) })}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <span className="min-w-24 text-center text-muted-foreground">
          {rowCount > 0 ? `${startRow}–${endRow}` : "—"}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          disabled={!hasMore || tab.loading}
          onClick={() => patchTab(tab.id, { offset: tab.offset + tab.limit })}
        >
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
