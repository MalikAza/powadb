import { Parser } from "node-sql-parser";
import { diagramDocSchema } from "@/lib/schemas";
import type { DbKind } from "@/types";
import { layoutDoc } from "./layout";
import type { DiagramColumn, DiagramDoc, DiagramEdge, DiagramTable } from "./types";
import { syncFkFlags, tableId } from "./types";

export type ImportResult = {
  doc: DiagramDoc;
  warnings: string[];
};

const PARSER_DIALECT: Record<DbKind, string> = {
  postgres: "postgresql",
  mysql: "mysql",
  sqlite: "sqlite",
  // Mongo and S3 have no SQL parsing; the diagram-import path is gated off via
  // capabilities long before this map is consulted.
  mongo: "postgresql",
  s3: "postgresql",
};

let counter = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++counter}`;

function collectNonEmpty<T>(
  arr: readonly T[] | null | undefined,
  fn: (t: T) => string | null | undefined,
): string[] {
  if (!arr) return [];
  const out: string[] = [];
  for (const t of arr) {
    const v = fn(t);
    if (v) out.push(v);
  }
  return out;
}

// ─── JSON import ─────────────────────────────────────────────────────────────

export function parseJsonImport(text: string): ImportResult {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }
  const result = diagramDocSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join(".") || "(root)";
    throw new Error(`Diagram doc validation failed at ${where}: ${first?.message ?? "unknown"}`);
  }
  const doc: DiagramDoc = result.data;
  // Keep parsed positions; they were exported intentionally.
  return { doc, warnings };
}

// ─── SQL import (best-effort via node-sql-parser) ────────────────────────────

type SqlTypeDef = {
  dataType?: string;
  length?: number;
  scale?: number;
};

type SqlColumn = {
  column?: { column?: { expr?: { value?: string } } | string };
  resource?: string;
  primary_key?: string | null;
  nullable?: { type?: string } | null;
  default_val?: { value?: { value?: unknown } } | null;
  reference_definition?: SqlRefDef | null;
  constraint_type?: string;
  // For column rows: a type def. For constraint rows: an array of column refs.
  definition?: SqlTypeDef | SqlColRef[];
  constraint?: string;
};

type SqlColRef = {
  type?: string;
  column?: { expr?: { value?: string } } | string;
};

type SqlRefDef = {
  definition?: SqlColRef[];
  table?: { table?: string; db?: string | null }[];
  on_action?: { type?: string; value?: { value?: string } }[];
};

type SqlCreateStmt = {
  type: "create";
  keyword: string;
  table?: { table?: string; db?: string | null }[];
  create_definitions?: SqlColumn[];
};

type SqlAlterStmt = {
  type: "alter";
  keyword: string;
  table?: { table?: string; db?: string | null }[];
  expr?: {
    action?: string;
    create_definitions?: SqlColumn;
    resource?: string;
  }[];
};

type AnyStmt = SqlCreateStmt | SqlAlterStmt | { type: string };

function statementsFromText(text: string): string[] {
  // Lightweight splitter matching the Rust splitter (kept simple: assumes our
  // dump output, not arbitrary SQL). Splits on `;` outside of single-quoted
  // strings and `--`/`/* */` comments.
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "-" && text[i + 1] === "-") {
      while (i < n && text[i] !== "\n") {
        cur += text[i];
        i++;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      cur += "/*";
      i += 2;
      while (i + 1 < n && !(text[i] === "*" && text[i + 1] === "/")) {
        cur += text[i];
        i++;
      }
      if (i + 1 < n) {
        cur += "*/";
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      cur += "'";
      i++;
      while (i < n) {
        const ch = text[i];
        cur += ch;
        i++;
        if (ch === "'") {
          if (text[i] === "'") {
            cur += "'";
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (c === ";") {
      const trimmed = cur.trim();
      if (trimmed) out.push(trimmed);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  const t = cur.trim();
  if (t) out.push(t);
  return out;
}

function colName(c: SqlColRef | undefined): string | null {
  if (!c) return null;
  if (typeof c.column === "string") return c.column;
  return c.column?.expr?.value ?? null;
}

function renderColumnType(def: SqlTypeDef | SqlColRef[] | undefined): string {
  if (!def || Array.isArray(def)) return "";
  const dt = (def.dataType ?? "").toLowerCase();
  if (def.length != null && def.scale != null) return `${dt}(${def.length},${def.scale})`;
  if (def.length != null) return `${dt}(${def.length})`;
  return dt;
}

function defaultLiteral(d: SqlColumn["default_val"]): string | null {
  if (!d) return null;
  const v = d.value?.value;
  if (v === undefined || v === null) return null;
  // Preserve string literals quoted; numbers/booleans plain.
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  return String(v);
}

export async function parseSqlImport(text: string, engine: DbKind): Promise<ImportResult> {
  const warnings: string[] = [];
  const parser = new Parser();
  const stmts = statementsFromText(text);
  const tables: DiagramTable[] = [];
  const tablesByName = new Map<string, DiagramTable>();
  const edges: DiagramEdge[] = [];

  function tableByName(name: string): DiagramTable | undefined {
    return tablesByName.get(name);
  }

  // Buffers populated during table parsing; resolved against the table list at
  // the end so forward references (FK to a table defined later) work.
  type PendingFk = {
    sourceTable: string;
    sourceCols: string[];
    target: string;
    targetCols: string[];
    name: string | null;
    onUpdate: string | null;
    onDelete: string | null;
  };
  const pendingFkSimples: PendingFk[] = [];
  const pendingMultiFks: PendingFk[] = [];

  function pushEdge(
    sourceTable: string,
    targetTable: string,
    sourceCols: string[],
    targetCols: string[],
    constraintName: string | null,
    onUpdate: string | null,
    onDelete: string | null,
  ) {
    const src = tableByName(sourceTable);
    const tgt = tableByName(targetTable);
    if (!src || !tgt) {
      warnings.push(
        `FK references unknown table — ${sourceTable}(${sourceCols.join(",")}) → ${targetTable}(${targetCols.join(",")})`,
      );
      return;
    }
    edges.push({
      id: uid("fk"),
      name: constraintName,
      source: src.id,
      target: tgt.id,
      sourceColumns: sourceCols,
      targetColumns: targetCols,
      onUpdate,
      onDelete,
    });
  }

  for (const stmt of stmts) {
    let ast: AnyStmt | AnyStmt[];
    try {
      ast = parser.astify(stmt, { database: PARSER_DIALECT[engine] }) as AnyStmt | AnyStmt[];
    } catch (e) {
      const head = stmt.slice(0, 60).replace(/\s+/g, " ");
      warnings.push(`Skipped unparseable statement (${(e as Error).message}): ${head}…`);
      continue;
    }
    const list = Array.isArray(ast) ? ast : [ast];
    for (const s of list) {
      if (s.type === "create" && (s as SqlCreateStmt).keyword === "table") {
        handleCreate(s as SqlCreateStmt);
      } else if (s.type === "alter" && (s as SqlAlterStmt).keyword === "table") {
        handleAlter(s as SqlAlterStmt);
      } else {
        warnings.push(`Skipped ${s.type} statement (only CREATE/ALTER TABLE imported)`);
      }
    }
  }

  function handleCreate(s: SqlCreateStmt) {
    const tableName = s.table?.[0]?.table ?? "";
    if (!tableName) {
      warnings.push("CREATE TABLE without a name was skipped");
      return;
    }
    const schema = defaultSchemaFor(engine);
    const id = tableId(schema, tableName);
    const cols: DiagramColumn[] = [];
    const pkCols: string[] = [];
    const inlineFks: Array<{
      sourceCol: string;
      target: string;
      targetCols: string[];
      onUpdate: string | null;
      onDelete: string | null;
    }> = [];

    for (const def of s.create_definitions ?? []) {
      // Top-level constraint (PRIMARY KEY (cols), FOREIGN KEY (cols) REFERENCES …, etc.)
      if (def.resource === "constraint") {
        const ct = (def.constraint_type ?? "").toLowerCase();
        if (ct === "primary key") {
          for (const c of (def.definition as SqlColRef[]) ?? []) {
            const n = colName(c);
            if (n) pkCols.push(n);
          }
        } else if (ct === "foreign key") {
          const ref = def.reference_definition;
          const srcCols = collectNonEmpty(def.definition as SqlColRef[] | undefined, colName);
          const tgtTable = ref?.table?.[0]?.table ?? "";
          const tgtCols = collectNonEmpty(ref?.definition, colName);
          if (srcCols.length && tgtTable && tgtCols.length) {
            const { onUpdate, onDelete } = fkRulesFrom(ref?.on_action);
            inlineFks.push({
              sourceCol: srcCols[0],
              target: tgtTable,
              targetCols: tgtCols,
              onUpdate,
              onDelete,
            });
            // Multi-column FK case
            if (srcCols.length > 1) {
              // Defer to a pending edge with all source cols.
              pendingMultiFks.push({
                sourceTable: tableName,
                sourceCols: srcCols,
                target: tgtTable,
                targetCols: tgtCols,
                name: def.constraint ?? null,
                onUpdate,
                onDelete,
              });
            } else {
              pendingFkSimples.push({
                sourceTable: tableName,
                sourceCols: srcCols,
                target: tgtTable,
                targetCols: tgtCols,
                name: def.constraint ?? null,
                onUpdate,
                onDelete,
              });
            }
          }
        }
        continue;
      }
      // Column definition
      const cName = colName(def.column as SqlColRef);
      if (!cName) continue;
      const isPk = (def.primary_key ?? "").toLowerCase().includes("primary");
      // PK columns are implicitly NOT NULL in every supported engine.
      const nullable = isPk ? false : (def.nullable?.type ?? "").toLowerCase() !== "not null";
      const dt = renderColumnType(def.definition);
      cols.push({
        id: `${id}.${cName}`,
        name: cName,
        originalName: cName,
        dataType: dt || "text",
        nullable,
        isPk,
        isFk: false,
        defaultValue: defaultLiteral(def.default_val),
      });
      if (isPk) pkCols.push(cName);
      if (def.reference_definition) {
        const ref = def.reference_definition;
        const tgtTable = ref.table?.[0]?.table ?? "";
        const tgtCols = collectNonEmpty(ref.definition, colName);
        if (tgtTable && tgtCols.length) {
          const { onUpdate, onDelete } = fkRulesFrom(ref.on_action);
          inlineFks.push({
            sourceCol: cName,
            target: tgtTable,
            targetCols: tgtCols,
            onUpdate,
            onDelete,
          });
          pendingFkSimples.push({
            sourceTable: tableName,
            sourceCols: [cName],
            target: tgtTable,
            targetCols: tgtCols,
            name: null,
            onUpdate,
            onDelete,
          });
        }
      }
    }

    // Mark composite PKs (when they came from a separate constraint, the cols
    // were defined above without isPk set).
    const colByName = new Map(cols.map((c) => [c.name, c]));
    for (const pk of pkCols) {
      const c = colByName.get(pk);
      if (c) c.isPk = true;
    }

    const table: DiagramTable = {
      id,
      schema,
      name: tableName,
      originalName: tableName,
      columns: cols,
      position: { x: 0, y: 0 },
    };
    tables.push(table);
    tablesByName.set(tableName, table);
  }

  function handleAlter(s: SqlAlterStmt) {
    const tableName = s.table?.[0]?.table ?? "";
    if (!tableName) {
      warnings.push("ALTER TABLE without a name was skipped");
      return;
    }
    for (const op of s.expr ?? []) {
      if (op.action !== "add" || op.resource !== "constraint") {
        warnings.push(`Unsupported ALTER on ${tableName} (only ADD CONSTRAINT imported)`);
        continue;
      }
      const def = op.create_definitions;
      if (!def) continue;
      const ct = (def.constraint_type ?? "").toLowerCase();
      if (ct !== "foreign key") {
        warnings.push(`Unsupported constraint type on ${tableName}: ${def.constraint_type}`);
        continue;
      }
      const srcCols = collectNonEmpty(def.definition as SqlColRef[] | undefined, colName);
      const ref = def.reference_definition;
      const tgtTable = ref?.table?.[0]?.table ?? "";
      const tgtCols = collectNonEmpty(ref?.definition, colName);
      if (!srcCols.length || !tgtTable || !tgtCols.length) {
        warnings.push(`Malformed ADD CONSTRAINT on ${tableName}, skipped`);
        continue;
      }
      const { onUpdate, onDelete } = fkRulesFrom(ref?.on_action);
      pendingFkSimples.push({
        sourceTable: tableName,
        sourceCols: srcCols,
        target: tgtTable,
        targetCols: tgtCols,
        name: def.constraint ?? null,
        onUpdate,
        onDelete,
      });
    }
  }

  for (const fk of [...pendingFkSimples, ...pendingMultiFks]) {
    pushEdge(
      fk.sourceTable,
      fk.target,
      fk.sourceCols,
      fk.targetCols,
      fk.name,
      fk.onUpdate,
      fk.onDelete,
    );
  }

  // Mark FK columns.
  const docPre: DiagramDoc = { version: 1, engine, tables, edges };
  const doc = syncFkFlags(docPre);

  const laid = await layoutDoc(doc);
  return { doc: laid, warnings };
}

function defaultSchemaFor(engine: DbKind): string {
  if (engine === "postgres") return "public";
  if (engine === "sqlite") return "main";
  return "";
}

function fkRulesFrom(on_action: SqlRefDef["on_action"]): {
  onUpdate: string | null;
  onDelete: string | null;
} {
  let onUpdate: string | null = null;
  let onDelete: string | null = null;
  for (const a of on_action ?? []) {
    const t = (a.type ?? "").toLowerCase();
    const v = a.value?.value ?? null;
    if (!v) continue;
    if (t === "on update") onUpdate = v.toUpperCase();
    else if (t === "on delete") onDelete = v.toUpperCase();
  }
  return { onUpdate, onDelete };
}
