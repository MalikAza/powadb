import { describe, expect, it } from "vitest";
import {
  CONNECTION_COLORS,
  connectionFormSchema,
  dbKindSchema,
  folderFormSchema,
  KIND_DEFAULTS,
  ROOT_FOLDER_SENTINEL,
  snippetSaveSchema,
  themeModeSchema,
} from "./schemas";

describe("dbKindSchema", () => {
  it("accepts known kinds", () => {
    expect(dbKindSchema.parse("postgres")).toBe("postgres");
    expect(dbKindSchema.parse("mysql")).toBe("mysql");
  });

  it("rejects unknown kinds", () => {
    expect(() => dbKindSchema.parse("sqlite")).toThrow();
  });
});

describe("themeModeSchema", () => {
  it("accepts known modes", () => {
    for (const m of ["light", "dark", "system"] as const) {
      expect(themeModeSchema.parse(m)).toBe(m);
    }
  });

  it("rejects unknown modes", () => {
    expect(() => themeModeSchema.parse("auto")).toThrow();
  });
});

describe("connectionFormSchema", () => {
  const baseValid = {
    name: "local pg",
    kind: "postgres" as const,
    host: "localhost",
    port: 5432,
    database: "app",
    username: "postgres",
    ssl: false,
    folder_id: null,
    color: null,
  };

  it("parses a valid connection", () => {
    const parsed = connectionFormSchema.parse(baseValid);
    expect(parsed.name).toBe("local pg");
    expect(parsed.port).toBe(5432);
    expect(parsed.password).toBe("");
    expect(parsed.folder_id).toBeNull();
  });

  it("coerces string port to a number", () => {
    const parsed = connectionFormSchema.parse({ ...baseValid, port: "3306" });
    expect(parsed.port).toBe(3306);
  });

  it("rejects out-of-range ports", () => {
    expect(() => connectionFormSchema.parse({ ...baseValid, port: 0 })).toThrow();
    expect(() => connectionFormSchema.parse({ ...baseValid, port: 70000 })).toThrow();
  });

  it("rejects empty required fields", () => {
    expect(() => connectionFormSchema.parse({ ...baseValid, name: "" })).toThrow();
    expect(() => connectionFormSchema.parse({ ...baseValid, host: "" })).toThrow();
    expect(() => connectionFormSchema.parse({ ...baseValid, username: "" })).toThrow();
  });

  it("allows empty database string", () => {
    const parsed = connectionFormSchema.parse({ ...baseValid, database: "" });
    expect(parsed.database).toBe("");
  });

  it("normalizes the root folder sentinel to null", () => {
    const parsed = connectionFormSchema.parse({
      ...baseValid,
      folder_id: ROOT_FOLDER_SENTINEL,
    });
    expect(parsed.folder_id).toBeNull();
  });

  it("preserves a real folder id", () => {
    const parsed = connectionFormSchema.parse({ ...baseValid, folder_id: "f-123" });
    expect(parsed.folder_id).toBe("f-123");
  });
});

describe("folderFormSchema", () => {
  it("requires a non-empty name", () => {
    expect(() => folderFormSchema.parse({ name: "", parent_id: null })).toThrow();
  });

  it("normalizes the root sentinel parent to null", () => {
    const parsed = folderFormSchema.parse({ name: "Work", parent_id: ROOT_FOLDER_SENTINEL });
    expect(parsed.parent_id).toBeNull();
  });
});

describe("snippetSaveSchema", () => {
  it("requires name and a known scope", () => {
    expect(snippetSaveSchema.parse({ name: "n", scope: "global" })).toEqual({
      name: "n",
      scope: "global",
    });
    expect(() => snippetSaveSchema.parse({ name: "", scope: "global" })).toThrow();
    expect(() => snippetSaveSchema.parse({ name: "n", scope: "team" })).toThrow();
  });
});

describe("KIND_DEFAULTS", () => {
  it("provides defaults for each db kind", () => {
    expect(KIND_DEFAULTS.postgres.port).toBe(5432);
    expect(KIND_DEFAULTS.mysql.port).toBe(3306);
  });
});

describe("CONNECTION_COLORS", () => {
  it("starts with a 'none' option whose value is null", () => {
    expect(CONNECTION_COLORS[0]?.name).toBe("none");
    expect(CONNECTION_COLORS[0]?.value).toBeNull();
  });
});
