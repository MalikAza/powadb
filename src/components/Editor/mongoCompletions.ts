import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { SchemaMeta } from "../../ipc";

// Static catalogs ---------------------------------------------------------

const OP_VALUES: Completion[] = [
  { label: "find", type: "keyword", detail: "read documents" },
  { label: "aggregate", type: "keyword", detail: "pipeline" },
  { label: "insert_one", type: "keyword", detail: "write a single document" },
  { label: "insert_many", type: "keyword", detail: "write multiple documents" },
  { label: "update_many", type: "keyword", detail: "modify matching documents" },
  { label: "delete_many", type: "keyword", detail: "remove matching documents" },
  { label: "run_command", type: "keyword", detail: "admin command" },
];

const TOP_LEVEL_KEYS: Completion[] = [
  { label: "op", type: "property", detail: "operation kind" },
  { label: "collection", type: "property", detail: "target collection" },
  { label: "database", type: "property", detail: "override database" },
  { label: "filter", type: "property", detail: "match selector" },
  { label: "projection", type: "property", detail: "field include/exclude" },
  { label: "sort", type: "property", detail: "{ field: 1 | -1 }" },
  { label: "limit", type: "property", detail: "max documents" },
  { label: "skip", type: "property", detail: "offset" },
  { label: "pipeline", type: "property", detail: "aggregation stages" },
  { label: "document", type: "property", detail: "doc to insert" },
  { label: "documents", type: "property", detail: "docs to insert" },
  { label: "update", type: "property", detail: "{ $set: { ... } }" },
];

const OPERATORS: Completion[] = [
  // comparison
  { label: "$eq", type: "function", detail: "equals" },
  { label: "$ne", type: "function", detail: "not equals" },
  { label: "$gt", type: "function", detail: "greater than" },
  { label: "$gte", type: "function", detail: "greater than or equal" },
  { label: "$lt", type: "function", detail: "less than" },
  { label: "$lte", type: "function", detail: "less than or equal" },
  { label: "$in", type: "function", detail: "matches any value" },
  { label: "$nin", type: "function", detail: "matches no value" },
  // logical
  { label: "$and", type: "function", detail: "all clauses match" },
  { label: "$or", type: "function", detail: "any clause matches" },
  { label: "$not", type: "function", detail: "negates a clause" },
  { label: "$nor", type: "function", detail: "no clause matches" },
  // element / evaluation
  { label: "$exists", type: "function", detail: "field present" },
  { label: "$type", type: "function", detail: "BSON type match" },
  { label: "$regex", type: "function", detail: "regex match" },
  { label: "$options", type: "function", detail: "regex options" },
  // arrays
  { label: "$all", type: "function", detail: "array contains all" },
  { label: "$elemMatch", type: "function", detail: "element matches all" },
  { label: "$size", type: "function", detail: "array length" },
  // update
  { label: "$set", type: "function", detail: "assign field" },
  { label: "$unset", type: "function", detail: "remove field" },
  { label: "$inc", type: "function", detail: "increment numeric" },
  { label: "$push", type: "function", detail: "append to array" },
  { label: "$pull", type: "function", detail: "remove from array" },
  { label: "$addToSet", type: "function", detail: "add unique to array" },
  { label: "$rename", type: "function", detail: "rename field" },
  // pipeline stages
  { label: "$match", type: "function", detail: "stage: filter" },
  { label: "$group", type: "function", detail: "stage: group" },
  { label: "$sort", type: "function", detail: "stage: sort" },
  { label: "$limit", type: "function", detail: "stage: limit" },
  { label: "$skip", type: "function", detail: "stage: skip" },
  { label: "$project", type: "function", detail: "stage: project" },
  { label: "$lookup", type: "function", detail: "stage: join" },
  { label: "$unwind", type: "function", detail: "stage: flatten array" },
  { label: "$count", type: "function", detail: "stage: count docs" },
];

const OID_TEMPLATE: Completion[] = [
  { label: '{ "$oid": "..." }', type: "constant", detail: "ObjectId wrapper" },
];

// DSL-mode catalogs -------------------------------------------------------

const DSL_METHODS: Completion[] = [
  { label: "find", type: "method", detail: "(filter?, projection?) → cursor" },
  { label: "findOne", type: "method", detail: "(filter?, projection?) → doc" },
  { label: "aggregate", type: "method", detail: "(pipeline) → cursor" },
  { label: "insertOne", type: "method", detail: "(doc) → ack" },
  { label: "insertMany", type: "method", detail: "([doc, …]) → ack" },
  { label: "updateOne", type: "method", detail: "(filter, update) → ack" },
  { label: "updateMany", type: "method", detail: "(filter, update) → ack" },
  { label: "deleteOne", type: "method", detail: "(filter) → ack" },
  { label: "deleteMany", type: "method", detail: "(filter) → ack" },
];

const DSL_CHAIN_METHODS: Completion[] = [
  { label: "limit", type: "method", detail: "(n) — cap result count" },
  { label: "skip", type: "method", detail: "(n) — offset" },
  { label: "sort", type: "method", detail: "({ field: 1 | -1 })" },
  { label: "project", type: "method", detail: "({ field: 1 | 0 })" },
];

const DSL_TOP_LEVEL: Completion[] = [
  { label: "db", type: "namespace", detail: "current connection" },
];

const DSL_DB_HELPERS: Completion[] = [
  { label: "runCommand", type: "method", detail: "(cmdDoc) — admin command" },
];

const DSL_CTORS: Completion[] = [
  { label: "ObjectId", type: "function", detail: 'ObjectId("<24-hex>")' },
  { label: "ISODate", type: "function", detail: 'ISODate("2026-01-01T00:00:00Z")' },
  { label: "Date", type: "function", detail: "new Date(...) — ISO-8601 string" },
  { label: "NumberLong", type: "function", detail: "NumberLong(n)" },
  { label: "NumberInt", type: "function", detail: "NumberInt(n)" },
  { label: "RegExp", type: "function", detail: "RegExp(pattern, flags)" },
];

// Context analysis --------------------------------------------------------

/// What kind of completion the cursor should produce, based on the JSON
/// shape of the text around it. The detector is intentionally lightweight —
/// it doesn't fully parse the document, just enough to tell apart the few
/// contexts that have distinct completion lists.
type CursorContext =
  | { kind: "op_value" } // user just typed `"op": "<here>"`
  | { kind: "collection_value" } // `"collection": "<here>"`
  | { kind: "database_value" } // `"database": "<here>"`
  | { kind: "key"; container: "top" | "nested" } // typing an object key
  | { kind: "value" } // generic value position
  // DSL-specific positions ------------------------------------------------
  | { kind: "dsl_db_member" } // right after `db.` — collection names + `runCommand`
  | { kind: "dsl_collection_method" } // after `db.users.` — find/insert/etc.
  | { kind: "dsl_chain_method" } // after `db.users.find(...).` — limit/skip/sort
  | { kind: "dsl_ctor" }; // bare ident in expression — ObjectId/ISODate/…

// Each regex captures the partial token at the cursor so we know how far
// back to anchor the completion replacement. Patterns end with `[^"]*$` to
// match while the user is mid-string (`"fi|` should still trigger op-value
// completions for "find"). Order matters: more specific patterns first.
const STRING_VALUE_OF_KEY_RE = /"([a-zA-Z_$][\w$.-]*)"\s*:\s*"([^"\n]*)$/;
const KEY_IN_QUOTES_RE = /(?:\{|,)\s*"([^"\n]*)$/;
const BARE_KEY_RE = /(?:\{|,)\s*([\w$]*)$/;
const VALUE_IN_QUOTES_RE = /:\s*"([^"\n]*)$/;

// DSL position detectors --------------------------------------------------
//
// These run AFTER the string-quoted detectors below — string contexts always
// win because they're inside literals where the DSL syntax doesn't apply.
const DSL_AFTER_DB_RE = /(?:^|[\s(,;])db\.([\w$]*)$/;
const DSL_AFTER_COLLECTION_RE = /(?:^|[\s(,;])db\.[\w$]+\.([\w$]*)$/;
// A chain-method position is `).<partial>` — the closing paren of the
// primary call is what tells us we're past the head method.
const DSL_AFTER_CHAIN_RE = /\)\s*\.([\w$]*)$/;

function detectContext(textBefore: string): (CursorContext & { prefixLen: number }) | null {
  // String-value contexts have highest priority: the user is mid-string,
  // so we should suggest values, not new keys / DSL identifiers.
  const sv = textBefore.match(STRING_VALUE_OF_KEY_RE);
  if (sv) {
    const prefixLen = sv[2].length;
    if (sv[1] === "op") return { kind: "op_value", prefixLen };
    if (sv[1] === "collection") return { kind: "collection_value", prefixLen };
    if (sv[1] === "database") return { kind: "database_value", prefixLen };
    return { kind: "value", prefixLen };
  }
  // Key inside quotes — `{ "fi|` or `, "fi|`.
  const k = textBefore.match(KEY_IN_QUOTES_RE);
  if (k) {
    const container = isTopLevel(textBefore) ? "top" : "nested";
    return { kind: "key", container, prefixLen: k[1].length };
  }

  // DSL positions: these only fire OUTSIDE object literals (depth 0). When
  // we're inside `{...}` the key/operator completions take precedence.
  if (depth(textBefore) === 0) {
    const chain = textBefore.match(DSL_AFTER_CHAIN_RE);
    if (chain) return { kind: "dsl_chain_method", prefixLen: chain[1].length };
    const coll = textBefore.match(DSL_AFTER_COLLECTION_RE);
    if (coll) return { kind: "dsl_collection_method", prefixLen: coll[1].length };
    const db = textBefore.match(DSL_AFTER_DB_RE);
    if (db) return { kind: "dsl_db_member", prefixLen: db[1].length };
  } else {
    // Inside a value position (after `:` or inside an array), a bare ident
    // is most likely a constructor call — `_id: Obj|`. We suggest helpers.
    const ctor = textBefore.match(/[:[,(]\s*([A-Z][\w$]*)$/);
    if (ctor) return { kind: "dsl_ctor", prefixLen: ctor[1].length };
  }

  // Bare key position (no quote yet) — Ctrl-Space after `{` or `,`.
  const bk = textBefore.match(BARE_KEY_RE);
  if (bk) {
    const container = isTopLevel(textBefore) ? "top" : "nested";
    return { kind: "key", container, prefixLen: bk[1].length };
  }
  // Generic string value not tied to a known key.
  const v = textBefore.match(VALUE_IN_QUOTES_RE);
  if (v) return { kind: "value", prefixLen: v[1].length };
  return null;
}

/// Total unmatched `{`/`[` depth (string-aware). Used to decide whether the
/// DSL identifier detectors should fire — they only apply at depth 0, since
/// inside an object literal the relevant suggestions are operators/fields,
/// not collection/method names.
function depth(textBefore: string): number {
  let d = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < textBefore.length; i++) {
    const ch = textBefore[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") d++;
    else if (ch === "}" || ch === "]") d--;
  }
  return d;
}

/// Decide whether the cursor sits at the top object level (where the
/// canonical MongoOp keys live) or deeper inside a nested filter/update
/// object (where Mongo operators are more useful). We walk back through
/// the text counting unmatched `{` so a single open brace at the start
/// means we're at depth 1 (top).
function isTopLevel(textBefore: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < textBefore.length; i++) {
    const ch = textBefore[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth === 1;
}

/// Find the `"collection": "name"` string in the document text so field
/// completions can be scoped to the actual collection the user is editing.
/// Returns `null` if no such field exists or it's not a string literal.
function extractCollection(docText: string): string | null {
  const re = /"collection"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/;
  const m = docText.match(re);
  return m ? m[1] : null;
}

// Public completion source ------------------------------------------------

/// Build a CodeMirror completion source for the MongoDB editor.
///
/// `schemas` is the introspected database/collection/field tree the schema
/// store keeps per connection. When the user has typed a `"collection"`
/// field, we look up its fields and surface them as key completions; we
/// also include them at value positions (e.g. inside `"sort"`/`"projection"`
/// objects) for quick field-name access.
export function buildMongoCompletionSource(schemas: SchemaMeta[] | undefined) {
  const collections: Completion[] = [];
  const fieldsByCollection = new Map<string, Completion[]>();
  if (schemas) {
    for (const db of schemas) {
      for (const t of db.tables) {
        collections.push({
          label: t.name,
          type: "type",
          detail: db.name,
        });
        const fields: Completion[] = t.columns.map((c) => ({
          label: c.name,
          type: "property",
          detail: c.data_type,
        }));
        fieldsByCollection.set(t.name, fields);
      }
    }
  }

  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.sliceDoc(0, ctx.pos);
    const cursorCtx = detectContext(before);
    if (!cursorCtx) return null;

    const docText = ctx.state.doc.toString();
    const collection = extractCollection(docText);
    const fields = collection ? (fieldsByCollection.get(collection) ?? []) : [];

    // Anchor the completion replacement at the start of the partial token
    // we matched (e.g. for `{ "fi|` the prefix is "fi", length 2, so we
    // replace from `ctx.pos - 2`). This lets the completion overwrite what
    // the user has already typed.
    const from = ctx.pos - cursorCtx.prefixLen;

    switch (cursorCtx.kind) {
      case "op_value":
        return { from, options: OP_VALUES, validFor: /^[\w_]*$/ };

      case "collection_value":
        return { from, options: collections, validFor: /^[\w.-]*$/ };

      case "database_value": {
        // Surface known databases from the schema list.
        const dbs: Completion[] = schemas
          ? schemas.map((s) => ({ label: s.name, type: "namespace" }))
          : [];
        return { from, options: dbs, validFor: /^[\w.-]*$/ };
      }

      case "key": {
        const options =
          cursorCtx.container === "top"
            ? dedupe([...TOP_LEVEL_KEYS, ...fields])
            : dedupe([...OPERATORS, ...fields]);
        return { from, options, validFor: /^[\w$]*$/ };
      }

      case "value":
        // Generic value position — surface field names (useful in $or / $and
        // operand objects), the ObjectId snippet, and DSL constructors so
        // the user can type `ObjectId(...)` after a key.
        return {
          from,
          options: dedupe([...fields, ...OID_TEMPLATE, ...DSL_CTORS]),
          validFor: /^[\w$]*$/,
        };

      case "dsl_db_member": {
        // After `db.` — collections (the common case) plus the lone
        // top-level helper `db.runCommand(...)`.
        return {
          from,
          options: dedupe([...collections, ...DSL_DB_HELPERS]),
          validFor: /^[\w$]*$/,
        };
      }
      case "dsl_collection_method":
        return { from, options: DSL_METHODS, validFor: /^[\w$]*$/ };
      case "dsl_chain_method":
        return { from, options: DSL_CHAIN_METHODS, validFor: /^[\w$]*$/ };
      case "dsl_ctor":
        return { from, options: DSL_CTORS, validFor: /^[\w$]*$/ };
    }
  };
}

// The `db` top-level identifier is not surfaced as a completion (users type
// it once at the start; CodeMirror's prefix matching means it would be
// noisy to suggest). It's exported only so the catalog list is complete for
// any future "starter snippet" feature.
export { DSL_TOP_LEVEL };

function dedupe(opts: Completion[]): Completion[] {
  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const o of opts) {
    if (seen.has(o.label)) continue;
    seen.add(o.label);
    out.push(o);
  }
  return out;
}
