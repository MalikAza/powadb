import { beforeEach, describe, expect, it } from "vitest";
import type { SchemaMeta } from "../ipc";
import { buildCmSchema, useSchema } from "./schema";

function reset() {
  useSchema.setState({ byConnection: {}, databasesByConnection: {} });
}

const sampleSchema: SchemaMeta = {
  name: "public",
  tables: [
    {
      name: "users",
      kind: "table",
      columns: [
        { name: "id", data_type: "int4", nullable: false },
        { name: "email", data_type: "text", nullable: true },
      ],
    },
    {
      name: "active_users",
      kind: "view",
      columns: [{ name: "id", data_type: "int4", nullable: false }],
    },
  ],
};

describe("useSchema", () => {
  beforeEach(reset);

  it("set stores schemas keyed by connection id", () => {
    useSchema.getState().set("c1", [sampleSchema]);
    expect(useSchema.getState().byConnection.c1).toEqual([sampleSchema]);
  });

  it("clear removes schemas and databases for a connection", () => {
    useSchema.getState().set("c1", [sampleSchema]);
    useSchema.getState().setDatabases("c1", ["app", "test"]);
    useSchema.getState().set("c2", [sampleSchema]);
    useSchema.getState().clear("c1");
    const s = useSchema.getState();
    expect(s.byConnection.c1).toBeUndefined();
    expect(s.databasesByConnection.c1).toBeUndefined();
    expect(s.byConnection.c2).toBeDefined();
  });

  it("setDatabases stores the list keyed by connection id", () => {
    useSchema.getState().setDatabases("c1", ["one", "two"]);
    expect(useSchema.getState().databasesByConnection.c1).toEqual(["one", "two"]);
  });
});

describe("buildCmSchema", () => {
  it("flattens to top-level tables for mysql", () => {
    const { schema, defaultSchema } = buildCmSchema([sampleSchema], "mysql");
    expect(defaultSchema).toBeUndefined();
    const ns = schema as Record<string, { self: { label: string }; children: unknown[] }>;
    expect(Object.keys(ns).sort()).toEqual(["active_users", "users"]);
    expect(ns.users?.self.label).toBe("users");
  });

  it("flattens to top-level tables for sqlite", () => {
    const { schema, defaultSchema } = buildCmSchema([sampleSchema], "sqlite");
    expect(defaultSchema).toBeUndefined();
    const ns = schema as Record<string, unknown>;
    expect(Object.keys(ns).sort()).toEqual(["active_users", "users"]);
  });

  it("nests tables under their schema for postgres and sets default schema to public", () => {
    const { schema, defaultSchema } = buildCmSchema([sampleSchema], "postgres");
    expect(defaultSchema).toBe("public");
    const ns = schema as Record<
      string,
      { self: { label: string; detail?: string }; children: Record<string, unknown> }
    >;
    expect(ns.public?.self.detail).toBe("schema");
    expect(Object.keys(ns.public?.children ?? {}).sort()).toEqual(["active_users", "users"]);
  });

  it("marks views with type 'class' and tables with type 'type'", () => {
    const { schema } = buildCmSchema([sampleSchema], "postgres");
    const ns = schema as Record<
      string,
      {
        children: Record<string, { self: { type: string; detail?: string } }>;
      }
    >;
    const view = ns.public?.children.active_users;
    const table = ns.public?.children.users;
    expect(view?.self.type).toBe("class");
    expect(view?.self.detail).toBe("view");
    expect(table?.self.type).toBe("type");
  });

  it("annotates non-nullable columns in the completion detail", () => {
    const { schema } = buildCmSchema([sampleSchema], "mysql");
    const ns = schema as Record<string, { children: Array<{ label: string; detail?: string }> }>;
    const cols = ns.users?.children ?? [];
    const idCol = cols.find((c) => c.label === "id");
    const emailCol = cols.find((c) => c.label === "email");
    expect(idCol?.detail).toBe("int4 not null");
    expect(emailCol?.detail).toBe("text");
  });
});
