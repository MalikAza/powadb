import { describe, expect, it } from "vitest";
import { diagramDocSchema, newTableFormSchema } from "./schemas";

const validDoc = {
  version: 1,
  engine: "postgres" as const,
  tables: [
    {
      id: "public.users",
      schema: "public",
      name: "users",
      columns: [
        {
          id: "public.users.id",
          name: "id",
          dataType: "integer",
          nullable: false,
          isPk: true,
          isFk: false,
          defaultValue: null,
        },
      ],
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
};

describe("diagramDocSchema", () => {
  it("accepts a minimal valid doc", () => {
    const out = diagramDocSchema.safeParse(validDoc);
    expect(out.success).toBe(true);
  });

  it("rejects a doc whose version is not 1", () => {
    const bad = { ...validDoc, version: 2 };
    const out = diagramDocSchema.safeParse(bad);
    expect(out.success).toBe(false);
  });

  it("rejects an unknown engine", () => {
    const out = diagramDocSchema.safeParse({ ...validDoc, engine: "oracle" });
    expect(out.success).toBe(false);
  });

  it("rejects a table with no columns", () => {
    const out = diagramDocSchema.safeParse({
      ...validDoc,
      tables: [{ ...validDoc.tables[0], columns: [] }],
    });
    expect(out.success).toBe(false);
  });
});

describe("newTableFormSchema", () => {
  it("accepts a table with a PK column", () => {
    const out = newTableFormSchema.safeParse({
      name: "books",
      columns: [{ name: "id", dataType: "integer", nullable: false, isPk: true, defaultValue: "" }],
    });
    expect(out.success).toBe(true);
  });

  it("rejects a table without any PK column", () => {
    const out = newTableFormSchema.safeParse({
      name: "books",
      columns: [
        { name: "id", dataType: "integer", nullable: false, isPk: false, defaultValue: "" },
      ],
    });
    expect(out.success).toBe(false);
  });

  it("rejects duplicate column names case-insensitively", () => {
    const out = newTableFormSchema.safeParse({
      name: "books",
      columns: [
        { name: "id", dataType: "integer", nullable: false, isPk: true, defaultValue: "" },
        { name: "ID", dataType: "text", nullable: true, isPk: false, defaultValue: "" },
      ],
    });
    expect(out.success).toBe(false);
  });
});
