import { useMemo } from "react";
import type { DiagFk } from "@/ipc";
import type { ByteaDisplayMode } from "@/lib/bytea";
import { isByteaColumn } from "@/lib/columnTypes";
import { columnDisplayKey } from "@/stores/columnDisplay";
import type { BrowseTab } from "@/stores/tabs";
import type { Column, DbKind } from "@/types";

export function useBrowseDerived({
  cols,
  fks,
  pkCols,
  kind,
  connId,
  schema,
  table,
  byteaModes,
}: {
  cols: Column[];
  fks: DiagFk[];
  pkCols: BrowseTab["pkCols"];
  kind: DbKind;
  connId: string;
  schema: string;
  table: string;
  byteaModes: Record<string, ByteaDisplayMode>;
}) {
  const colIndexByName = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < cols.length; i++) m.set(cols[i].name, i);
    return m;
  }, [cols]);
  const pkColIndexes = useMemo(() => {
    if (!pkCols) return null;
    const idxs: number[] = [];
    for (const pk of pkCols) {
      const i = colIndexByName.get(pk);
      if (i === undefined) return null;
      idxs.push(i);
    }
    return idxs;
  }, [pkCols, colIndexByName]);
  const fkByColumn = useMemo(() => {
    const map = new Map<string, DiagFk>();
    for (const fk of fks) {
      for (const col of fk.from_columns) {
        if (!map.has(col)) map.set(col, fk);
      }
    }
    return map;
  }, [fks]);
  const byteaColMode = useMemo(() => {
    const out = new Map<number, ByteaDisplayMode>();
    cols.forEach((c, i) => {
      if (!isByteaColumn(kind, c)) return;
      out.set(i, byteaModes[columnDisplayKey(connId, schema, table, c.name)] ?? "hex");
    });
    return out;
  }, [cols, kind, connId, schema, table, byteaModes]);
  return { colIndexByName, pkColIndexes, fkByColumn, byteaColMode };
}
