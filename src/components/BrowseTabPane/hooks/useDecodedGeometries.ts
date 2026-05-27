import { useEffect, useReducer } from "react";
import { ipc } from "@/ipc";
import { isGeoColumn } from "@/lib/columnTypes";
import type { DbKind, QueryResult } from "@/types";
import { type GeomDecoded, geomKey } from "../helpers";

export function useDecodedGeometries(
  connectionId: string,
  kind: DbKind,
  result: QueryResult,
): Map<string, GeomDecoded> {
  const [decoded, dispatch] = useReducer(
    (_s: Map<string, GeomDecoded>, next: Map<string, GeomDecoded>) => next,
    new Map<string, GeomDecoded>(),
  );
  useEffect(() => {
    const cols = result.columns;
    const targets: Array<{ row: number; col: number; hex: string }> = [];
    if (kind === "postgres") {
      cols.forEach((c, colIdx) => {
        if (!isGeoColumn(kind, c)) return;
        result.rows.forEach((row, rowIdx) => {
          const v = row[colIdx];
          if (typeof v === "string" && v !== "") {
            targets.push({ row: rowIdx, col: colIdx, hex: v });
          }
        });
      });
    }
    if (targets.length === 0) {
      dispatch(new Map());
      return;
    }
    let cancelled = false;
    ipc
      .decodeGeometries(
        connectionId,
        targets.map((t) => t.hex),
      )
      .then((entries) => {
        if (cancelled) return;
        const next = new Map<string, GeomDecoded>();
        entries.forEach((entry, i) => {
          if (!entry) return;
          const { row, col } = targets[i];
          let coordsJson = "";
          try {
            const obj = JSON.parse(entry.geojson) as { coordinates?: unknown };
            coordsJson = JSON.stringify(obj.coordinates ?? null);
          } catch {
            coordsJson = entry.geojson;
          }
          next.set(geomKey(row, col), { ...entry, coordsJson });
        });
        dispatch(next);
      })
      .catch(() => {
        if (!cancelled) dispatch(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [result, connectionId, kind]);
  return decoded;
}
