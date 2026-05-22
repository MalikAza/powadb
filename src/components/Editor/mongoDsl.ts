// Mongosh-style DSL parser for the Mongo query editor.
//
// Accepts a small, pragmatic subset of what mongosh / the legacy mongo
// shell understands — enough to express every variant of our backend
// `MongoOp`:
//
//   db.users.find({ age: { $gt: 18 } }).limit(10).skip(5).sort({ name: 1 })
//   db.users.findOne({ _id: ObjectId("65f...") })
//   db.orders.aggregate([{ $match: {...} }, { $group: {...} }])
//   db.users.insertOne({ name: "alice", at: ISODate("2026-01-01T00:00:00Z") })
//   db.users.insertMany([{...}, {...}])
//   db.users.updateOne({ _id: ObjectId("...") }, { $set: { age: 30 } })
//   db.users.updateMany({ active: true }, { $set: { status: "ok" } })
//   db.users.deleteOne({ _id: ObjectId("...") })
//   db.users.deleteMany({ archived: true })
//   db.runCommand({ ping: 1 })
//
// Optional database prefix (mongosh's `use <db>`):
//   use commune;
//   db.users.findOne({ _id: ObjectId("…") })
//
// The connection's URI usually only authenticates against one database
// (often `admin` for shared clusters). Without `use`, every query runs
// against that auth database — which is rarely the one you actually want.
// `use <db>;` overrides the target on the emitted op.
//
// Deliberately NOT supported (we error helpfully):
//   * multiple statements (`db.x.find(); db.y.find()`) — one op per run
//   * Bash-style cursors (`.forEach`, `.toArray`, `.pretty`)
//   * assignment / `let` / `var` (it's a query, not a script)
//   * template literals (`` `${foo}` ``) — use plain strings
//
// The parser is hand-rolled: a small lexer feeds a recursive-descent
// expression parser. No external JS parser dependency — the surface area
// we accept is small enough that a real JS parser would be overkill and
// brittle (it would also accept things that aren't valid Mongo queries).

import type { MongoOp } from "../../ipc";

// ─── Public API ──────────────────────────────────────────────────────────

export type ParseResult = { ok: true; op: MongoOp } | { ok: false; error: string };

/// Parse a mongosh-style query string into a `MongoOp`. Returns a tagged
/// result rather than throwing so callers can surface the error in the UI
/// without try/catch noise.
export function parseMongoDsl(source: string): ParseResult {
  try {
    const tokens = tokenize(source);
    const parser = new Parser(tokens, source);
    const op = parser.parseQuery();
    parser.expectEof();
    return { ok: true, op };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Lexer ────────────────────────────────────────────────────────────────

type TokKind =
  | "punct" // { } [ ] ( ) , : .
  | "ident" // identifiers and keywords (true/false/null/new/etc.)
  | "string" // "..." or '...'
  | "number" // integer / float, with optional leading -
  | "regex" // /pattern/flags
  | "eof";

type Token = {
  kind: TokKind;
  value: string;
  pos: number; // byte offset in source, used for error messages
};

const PUNCT_CHARS = new Set(["{", "}", "[", "]", "(", ")", ",", ":", ".", ";"]);
const IDENT_START = /[A-Za-z_$]/;
const IDENT_CONT = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    // Single-line comment
    if (ch === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }

    // Block comment
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      if (i >= src.length) {
        throw new ParseError("unterminated /* */ comment", i);
      }
      i += 2;
      continue;
    }

    // Regex literal — only when `/` could legitimately start a regex (we
    // don't have division in our DSL, so any `/` that isn't a comment is a
    // regex).
    if (ch === "/") {
      const start = i;
      i++;
      let body = "";
      let inClass = false;
      while (i < src.length) {
        const c = src[i];
        if (c === "\\" && i + 1 < src.length) {
          body += c + src[i + 1];
          i += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        if (c === "\n") throw new ParseError("unterminated regex literal", start);
        body += c;
        i++;
      }
      if (src[i] !== "/") throw new ParseError("unterminated regex literal", start);
      i++; // consume closing /
      let flags = "";
      while (i < src.length && /[gimsuy]/.test(src[i])) {
        flags += src[i];
        i++;
      }
      out.push({ kind: "regex", value: JSON.stringify({ source: body, flags }), pos: start });
      continue;
    }

    // Punctuation
    if (PUNCT_CHARS.has(ch)) {
      out.push({ kind: "punct", value: ch, pos: i });
      i++;
      continue;
    }

    // String literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i++;
      let value = "";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          value += parseEscape(src[i + 1], start);
          i += 2;
          continue;
        }
        if (src[i] === "\n") throw new ParseError("unterminated string literal", start);
        value += src[i];
        i++;
      }
      if (src[i] !== quote) throw new ParseError("unterminated string literal", start);
      i++;
      out.push({ kind: "string", value, pos: start });
      continue;
    }

    // Number (allow leading `-` only at expression start — handled by parser
    // via separate unary; here we tokenize bare digits, `.5`, `0.5`, `1.5`).
    if (DIGIT.test(ch) || (ch === "." && DIGIT.test(src[i + 1] ?? ""))) {
      const start = i;
      while (i < src.length && (DIGIT.test(src[i]) || src[i] === ".")) i++;
      // optional exponent
      if (i < src.length && (src[i] === "e" || src[i] === "E")) {
        i++;
        if (src[i] === "+" || src[i] === "-") i++;
        while (i < src.length && DIGIT.test(src[i])) i++;
      }
      out.push({ kind: "number", value: src.slice(start, i), pos: start });
      continue;
    }

    // Identifier
    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < src.length && IDENT_CONT.test(src[i])) i++;
      out.push({ kind: "ident", value: src.slice(start, i), pos: start });
      continue;
    }

    // Unary minus before number: keep `-` as ident-ish and let parser handle.
    if (ch === "-") {
      out.push({ kind: "punct", value: "-", pos: i });
      i++;
      continue;
    }

    throw new ParseError(`unexpected character '${ch}'`, i);
  }
  out.push({ kind: "eof", value: "", pos: src.length });
  return out;
}

function parseEscape(c: string, pos: number): string {
  switch (c) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "v":
      return "\v";
    case "0":
      return "\0";
    case "\\":
    case '"':
    case "'":
    case "/":
      return c;
    default:
      throw new ParseError(`unknown escape sequence \\${c}`, pos);
  }
}

// ─── Parser ───────────────────────────────────────────────────────────────

class ParseError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
  ) {
    super(message);
  }
}

class Parser {
  private idx = 0;
  constructor(
    private tokens: Token[],
    private source: string,
  ) {}

  private peek(offset = 0): Token {
    return this.tokens[this.idx + offset] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    const t = this.tokens[this.idx];
    this.idx++;
    return t;
  }

  private match(kind: TokKind, value?: string): boolean {
    const t = this.peek();
    if (t.kind !== kind) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }

  private consume(kind: TokKind, value?: string): Token {
    const t = this.peek();
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw this.errorAt(t, `expected ${value ? `'${value}'` : kind}, got ${describe(t)}`);
    }
    this.advance();
    return t;
  }

  expectEof(): void {
    // Tolerate a trailing semicolon.
    if (this.match("punct", ";")) this.advance();
    if (!this.match("eof")) {
      throw this.errorAt(
        this.peek(),
        `expected end of input, got ${describe(this.peek())} (only one statement per run)`,
      );
    }
  }

  private errorAt(tok: Token, msg: string): ParseError {
    const { line, col } = locate(this.source, tok.pos);
    return new ParseError(`${msg} (line ${line}, col ${col})`, tok.pos);
  }

  // ─── Top-level: [use <db>;] db.<collection>.<method>(<args>).<chain>... ──

  parseQuery(): MongoOp {
    // Optional `use <db>;` prefix — pulls the target database off the
    // statement so the rest of the parser can pretend it doesn't exist.
    // We accept both bare identifiers (`use commune`) and quoted strings
    // (`use "my-db";`) because mongosh allows both.
    let database: string | undefined;
    if (this.match("ident", "use")) {
      this.advance();
      const target = this.peek();
      if (target.kind === "ident" || target.kind === "string") {
        this.advance();
        database = target.value;
      } else {
        throw this.errorAt(target, `expected database name after 'use', got ${describe(target)}`);
      }
      if (this.match("punct", ";")) this.advance();
    }

    const dbTok = this.consume("ident");
    if (dbTok.value !== "db") {
      throw this.errorAt(dbTok, `expected query to start with 'db', got '${dbTok.value}'`);
    }
    this.consume("punct", ".");
    const firstIdent = this.consume("ident");

    // `db.runCommand({...})` is a special two-segment chain (no collection).
    if (firstIdent.value === "runCommand") {
      this.consume("punct", "(");
      const arg = this.parseExpr();
      this.consume("punct", ")");
      this.expectArgsClosed();
      return { op: "run_command", value: arg };
    }

    const collection = firstIdent.value;
    this.consume("punct", ".");
    const methodTok = this.consume("ident");
    this.consume("punct", "(");
    const args = this.parseArgList();
    this.consume("punct", ")");

    // Build the op, possibly augmented by chained .limit/.skip/.sort/.project.
    const op = this.buildPrimaryOp(collection, methodTok, args);
    const chained = this.applyChain(op);
    // `run_command` is the only variant without a `database` field — it has
    // its own dispatch above and wouldn't reach here anyway, but the type
    // narrows on `op.op` to make this explicit.
    if (!database || chained.op === "run_command") return chained;
    return { ...chained, database };
  }

  private buildPrimaryOp(collection: string, methodTok: Token, args: unknown[]): MongoOp {
    const m = methodTok.value;
    const need = (n: number, what: string) => {
      if (args.length !== n) {
        throw this.errorAt(methodTok, `${m}() expects ${n} argument${n === 1 ? "" : "s"}: ${what}`);
      }
    };
    switch (m) {
      case "find":
        if (args.length > 2) {
          throw this.errorAt(methodTok, "find() expects at most 2 arguments: filter, projection");
        }
        return {
          op: "find",
          collection,
          filter: args[0] ?? {},
          ...(args[1] !== undefined ? { projection: args[1] } : {}),
        };
      case "findOne":
        if (args.length > 2) {
          throw this.errorAt(methodTok, "findOne() expects at most 2 arguments");
        }
        return {
          op: "find_one",
          collection,
          filter: args[0] ?? {},
          ...(args[1] !== undefined ? { projection: args[1] } : {}),
        };
      case "aggregate": {
        need(1, "pipeline array");
        if (!Array.isArray(args[0])) {
          throw this.errorAt(methodTok, "aggregate() expects an array of stage objects");
        }
        return { op: "aggregate", collection, pipeline: args[0] };
      }
      case "insertOne":
        need(1, "document");
        return { op: "insert_one", collection, document: args[0] };
      case "insertMany": {
        need(1, "array of documents");
        if (!Array.isArray(args[0])) {
          throw this.errorAt(methodTok, "insertMany() expects an array of documents");
        }
        return { op: "insert_many", collection, documents: args[0] };
      }
      case "updateOne":
        need(2, "filter, update");
        return { op: "update_one", collection, filter: args[0], update: args[1] };
      case "updateMany":
        need(2, "filter, update");
        return { op: "update_many", collection, filter: args[0], update: args[1] };
      case "deleteOne":
        need(1, "filter");
        return { op: "delete_one", collection, filter: args[0] };
      case "deleteMany":
        need(1, "filter");
        return { op: "delete_many", collection, filter: args[0] };
      default:
        throw this.errorAt(
          methodTok,
          `unknown method '${m}'. Supported: find, findOne, aggregate, insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany`,
        );
    }
  }

  // ─── Chain: .limit(n) / .skip(n) / .sort({...}) / .project({...}) ────

  private applyChain(op: MongoOp): MongoOp {
    let current = op;
    while (this.match("punct", ".")) {
      this.advance();
      const methodTok = this.consume("ident");
      this.consume("punct", "(");
      const args = this.parseArgList();
      this.consume("punct", ")");
      current = this.applyChainMethod(current, methodTok, args);
    }
    return current;
  }

  private applyChainMethod(op: MongoOp, methodTok: Token, args: unknown[]): MongoOp {
    const m = methodTok.value;
    if (op.op !== "find") {
      throw this.errorAt(methodTok, `.${m}() can only be chained off find() (got ${op.op})`);
    }
    switch (m) {
      case "limit": {
        const n = asInt(args[0], methodTok, "limit() expects an integer");
        return { ...op, limit: n };
      }
      case "skip": {
        const n = asInt(args[0], methodTok, "skip() expects an integer");
        return { ...op, skip: n };
      }
      case "sort": {
        if (args.length !== 1) {
          throw this.errorAt(methodTok, "sort() expects 1 argument");
        }
        return { ...op, sort: args[0] };
      }
      case "project":
      case "projection": {
        if (args.length !== 1) {
          throw this.errorAt(methodTok, `${m}() expects 1 argument`);
        }
        return { ...op, projection: args[0] };
      }
      default:
        throw this.errorAt(
          methodTok,
          `unknown chain method '.${m}()'. Supported: .limit(), .skip(), .sort(), .project()`,
        );
    }
  }

  // ─── Argument list ───────────────────────────────────────────────────

  private parseArgList(): unknown[] {
    const args: unknown[] = [];
    if (this.match("punct", ")")) return args;
    args.push(this.parseExpr());
    while (this.match("punct", ",")) {
      this.advance();
      if (this.match("punct", ")")) break; // trailing comma
      args.push(this.parseExpr());
    }
    return args;
  }

  private expectArgsClosed(): void {
    // Used by runCommand which has its own ) consumed already. No-op for now.
  }

  // ─── Expression: literal | object | array | call | unary minus ───────

  private parseExpr(): unknown {
    const t = this.peek();

    if (t.kind === "punct" && t.value === "{") return this.parseObject();
    if (t.kind === "punct" && t.value === "[") return this.parseArray();
    if (t.kind === "string") {
      this.advance();
      return t.value;
    }
    if (t.kind === "number") {
      this.advance();
      return Number.parseFloat(t.value);
    }
    if (t.kind === "punct" && t.value === "-") {
      this.advance();
      const next = this.peek();
      if (next.kind !== "number") {
        throw this.errorAt(next, `expected number after '-', got ${describe(next)}`);
      }
      this.advance();
      return -Number.parseFloat(next.value);
    }
    if (t.kind === "regex") {
      this.advance();
      const { source, flags } = JSON.parse(t.value);
      return { $regex: source, $options: flags };
    }
    if (t.kind === "ident") {
      return this.parseIdentExpr();
    }
    throw this.errorAt(t, `unexpected ${describe(t)} in expression`);
  }

  private parseIdentExpr(): unknown {
    const t = this.advance();
    switch (t.value) {
      case "true":
        return true;
      case "false":
        return false;
      case "null":
        return null;
      case "undefined":
        return null; // BSON has no undefined; closest sensible mapping
    }
    // `new Date(...)` — strip the `new` keyword and fall through to call.
    if (t.value === "new") {
      const ctor = this.consume("ident");
      return this.parseCall(ctor);
    }
    // Constructor-shaped call: ObjectId("..."), ISODate("..."), NumberLong("..").
    if (this.match("punct", "(")) {
      return this.parseCall(t);
    }
    throw this.errorAt(
      t,
      `unexpected identifier '${t.value}' — strings must be quoted, helpers must be called like ObjectId("...")`,
    );
  }

  private parseCall(ctorTok: Token): unknown {
    this.consume("punct", "(");
    const args = this.parseArgList();
    this.consume("punct", ")");
    return liftCtor(ctorTok, args);
  }

  // ─── Object literal: { key: value, "key": value, ... } ──────────────

  private parseObject(): Record<string, unknown> {
    this.consume("punct", "{");
    const out: Record<string, unknown> = {};
    if (this.match("punct", "}")) {
      this.advance();
      return out;
    }
    const firstKey = this.parseKey();
    this.consume("punct", ":");
    out[firstKey] = this.parseExpr();
    while (this.match("punct", ",")) {
      this.advance();
      if (this.match("punct", "}")) break; // trailing comma
      const k = this.parseKey();
      this.consume("punct", ":");
      out[k] = this.parseExpr();
    }
    this.consume("punct", "}");
    return out;
  }

  private parseKey(): string {
    const t = this.peek();
    if (t.kind === "string" || t.kind === "ident") {
      this.advance();
      return t.value;
    }
    // Numeric keys are valid in JS object literals; allow them too.
    if (t.kind === "number") {
      this.advance();
      return t.value;
    }
    throw this.errorAt(t, `expected object key, got ${describe(t)}`);
  }

  // ─── Array literal: [ value, value, ... ] ──────────────────────────

  private parseArray(): unknown[] {
    this.consume("punct", "[");
    const out: unknown[] = [];
    if (this.match("punct", "]")) {
      this.advance();
      return out;
    }
    out.push(this.parseExpr());
    while (this.match("punct", ",")) {
      this.advance();
      if (this.match("punct", "]")) break;
      out.push(this.parseExpr());
    }
    this.consume("punct", "]");
    return out;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const HEX24 = /^[a-fA-F0-9]{24}$/;

/// Map a constructor-shaped call to its extJSON / BSON equivalent. These
/// are the helpers mongosh users reach for routinely; we recognize the
/// common ones and pass anything else through as a tagged `{$call}` so the
/// user gets a clear error rather than a silent type mismatch.
function liftCtor(ctorTok: Token, args: unknown[]): unknown {
  switch (ctorTok.value) {
    case "ObjectId": {
      if (args.length === 0) {
        // Bare `ObjectId()` — backend treats it as a generate-new request;
        // we don't, since the wire format only carries a value. Emit a
        // helpful error.
        throw new ParseError(
          "ObjectId() without an argument isn't supported — provide a 24-char hex string",
          ctorTok.pos,
        );
      }
      const arg = args[0];
      if (typeof arg !== "string" || !HEX24.test(arg)) {
        throw new ParseError(
          `ObjectId(...) expects a 24-char hex string, got ${JSON.stringify(arg)}`,
          ctorTok.pos,
        );
      }
      return { $oid: arg };
    }
    case "ISODate":
    case "Date": {
      if (args.length === 0) return { $date: new Date().toISOString() };
      const arg = args[0];
      if (typeof arg !== "string") {
        throw new ParseError(`${ctorTok.value}(...) expects an ISO-8601 string`, ctorTok.pos);
      }
      const parsed = new Date(arg);
      if (Number.isNaN(parsed.getTime())) {
        throw new ParseError(`invalid date string: ${JSON.stringify(arg)}`, ctorTok.pos);
      }
      return { $date: parsed.toISOString() };
    }
    case "NumberLong":
    case "NumberInt": {
      const arg = args[0];
      if (typeof arg === "number") return arg;
      if (typeof arg === "string") {
        const n = Number(arg);
        if (Number.isNaN(n)) {
          throw new ParseError(`invalid number: ${JSON.stringify(arg)}`, ctorTok.pos);
        }
        return n;
      }
      throw new ParseError(`${ctorTok.value}(...) expects a number or string`, ctorTok.pos);
    }
    case "RegExp": {
      const pattern = args[0];
      const flags = args[1] ?? "";
      if (typeof pattern !== "string" || typeof flags !== "string") {
        throw new ParseError("RegExp(pattern, flags) expects two strings", ctorTok.pos);
      }
      return { $regex: pattern, $options: flags };
    }
    default:
      throw new ParseError(
        `unknown constructor '${ctorTok.value}'. Supported: ObjectId, ISODate, Date, NumberLong, NumberInt, RegExp`,
        ctorTok.pos,
      );
  }
}

function asInt(v: unknown, tok: Token, msg: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new ParseError(msg, tok.pos);
  }
  return v;
}

function describe(t: Token): string {
  if (t.kind === "eof") return "end of input";
  if (t.kind === "string") return `string ${JSON.stringify(t.value)}`;
  if (t.kind === "number") return `number ${t.value}`;
  if (t.kind === "ident") return `'${t.value}'`;
  if (t.kind === "regex") return "regex literal";
  return `'${t.value}'`;
}

function locate(src: string, pos: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < src.length; i++) {
    if (src[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}
