import { cn } from "@/lib/utils";
import type { DbKind, QueryResult } from "../types";

type Props = {
  result: QueryResult;
};

export function ExplainView({ result }: Props) {
  const raw = result.rows[0]?.[0];
  const plan = parsePlan(raw);

  if (plan?.kind === "postgres") {
    return (
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card p-3">
        <PgPlanNode node={plan.root} depth={0} />
      </div>
    );
  }

  if (plan?.kind === "mysql") {
    return (
      <pre className="m-0 min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-xs">
        {JSON.stringify(plan.body, null, 2)}
      </pre>
    );
  }

  return (
    <pre className="m-0 min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-xs">
      {typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)}
    </pre>
  );
}

type Plan = { kind: "postgres"; root: PgNode } | { kind: "mysql"; body: unknown };

type PgNode = {
  "Node Type"?: string;
  "Total Cost"?: number;
  "Startup Cost"?: number;
  "Plan Rows"?: number;
  "Actual Total Time"?: number;
  "Actual Rows"?: number;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PgNode[];
  [k: string]: unknown;
};

function parsePlan(raw: unknown): Plan | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] && "Plan" in v[0]) {
    return { kind: "postgres", root: (v[0] as { Plan: PgNode }).Plan };
  }
  if (typeof v === "object" && v !== null && "query_block" in (v as object)) {
    return { kind: "mysql", body: v };
  }
  return null;
}

function PgPlanNode({ node, depth }: { node: PgNode; depth: number }) {
  const cost = node["Total Cost"];
  const startup = node["Startup Cost"];
  const planRows = node["Plan Rows"];
  const actualTime = node["Actual Total Time"];
  const actualRows = node["Actual Rows"];
  const target = node["Relation Name"] ?? node["Index Name"];

  return (
    <div className={cn("mb-2", depth > 0 && "ml-4")}>
      <div
        className={cn(
          "rounded-md border border-border p-2 font-mono text-xs",
          depth === 0 ? "bg-primary/10" : "bg-muted/40",
        )}
      >
        <div className="flex items-baseline justify-between gap-3">
          <strong className="text-foreground">
            {node["Node Type"]}
            {target && <span className="ml-1 font-normal text-muted-foreground">on {target}</span>}
          </strong>
          <span className="whitespace-nowrap text-muted-foreground">
            {cost != null && (
              <>
                cost={fmtNum(startup)}..{fmtNum(cost)}
              </>
            )}
            {planRows != null && <> · rows={fmtNum(planRows)}</>}
          </span>
        </div>
        {(actualTime != null || actualRows != null) && (
          <div className="mt-1 text-muted-foreground">
            {actualTime != null && <>actual time={fmtNum(actualTime)}ms</>}
            {actualRows != null && <> · actual rows={fmtNum(actualRows)}</>}
          </div>
        )}
        <DetailLines node={node} />
      </div>
      {node.Plans?.map((child) => (
        <PgPlanNode
          key={`${child["Node Type"] ?? "?"}::${child.Alias ?? ""}::${child["Index Name"] ?? ""}::${child["Relation Name"] ?? ""}`}
          node={child}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

const DETAIL_KEYS = [
  "Filter",
  "Index Cond",
  "Recheck Cond",
  "Hash Cond",
  "Merge Cond",
  "Join Type",
  "Sort Key",
  "Group Key",
  "Strategy",
];

function DetailLines({ node }: { node: PgNode }) {
  const lines = DETAIL_KEYS.flatMap((k) => {
    const v = node[k];
    if (v == null) return [];
    return [`${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`];
  });
  if (lines.length === 0) return null;
  return (
    <div className="mt-1 text-[11px] text-muted-foreground">
      {lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  );
}

function fmtNum(n: unknown): string {
  if (typeof n !== "number") return "?";
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

export function isExplainResult(result: QueryResult): boolean {
  if (result.columns.length !== 1) return false;
  const name = result.columns[0]?.name?.toUpperCase() ?? "";
  return name === "QUERY PLAN" || name === "EXPLAIN";
}

export function wrapAsExplain(sql: string, kind: DbKind, analyze: boolean): string {
  const trimmed = sql.trim().replace(/;$/, "");
  if (kind === "postgres") {
    const opts = analyze ? "FORMAT JSON, ANALYZE, BUFFERS" : "FORMAT JSON";
    return `EXPLAIN (${opts}) ${trimmed}`;
  }
  if (kind === "sqlite") {
    return `EXPLAIN QUERY PLAN ${trimmed}`;
  }
  return `EXPLAIN FORMAT=JSON ${trimmed}`;
}
