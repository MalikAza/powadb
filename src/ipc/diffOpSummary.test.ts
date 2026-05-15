import { describe, expect, it } from "vitest";
import { type DiffOp, diffOpSummary } from "./index";

describe("diffOpSummary", () => {
  it("formats every op kind in the union", () => {
    const cases: { op: DiffOp; expect: string }[] = [
      {
        op: { kind: "add_table", schema: "public", name: "users", columns: [] },
        expect: "+ table public.users",
      },
      {
        op: { kind: "drop_table", schema: "", name: "tmp" },
        expect: "− table tmp",
      },
      {
        op: { kind: "rename_table", schema: "public", from: "u", to: "users" },
        expect: "~ rename table u → users",
      },
      {
        op: {
          kind: "add_column",
          schema: "public",
          table: "users",
          column: {
            name: "email",
            data_type: "text",
            nullable: true,
            is_pk: false,
            default_value: null,
          },
        },
        expect: "+ column users.email",
      },
      {
        op: { kind: "drop_column", schema: "public", table: "users", column: "legacy" },
        expect: "− column users.legacy",
      },
      {
        op: {
          kind: "rename_column",
          schema: "public",
          table: "users",
          from: "email",
          to: "contact",
        },
        expect: "~ rename column users.email → contact",
      },
      {
        op: {
          kind: "alter_column_type",
          schema: "public",
          table: "users",
          column: "email",
          new_type: "varchar(320)",
        },
        expect: "~ users.email type → varchar(320)",
      },
      {
        op: {
          kind: "alter_column_nullable",
          schema: "public",
          table: "users",
          column: "name",
          nullable: false,
        },
        expect: "~ users.name NOT NULL",
      },
      {
        op: {
          kind: "alter_column_default",
          schema: "public",
          table: "users",
          column: "name",
          default: "'anon'",
        },
        expect: "~ users.name DEFAULT 'anon'",
      },
      {
        op: {
          kind: "add_fk",
          schema: "public",
          table: "books",
          constraint_name: null,
          columns: ["author_id"],
          target_schema: "public",
          target_table: "authors",
          target_columns: ["id"],
          on_update: null,
          on_delete: null,
        },
        expect: "+ FK books(author_id) → authors(id)",
      },
      {
        op: {
          kind: "drop_fk",
          schema: "public",
          table: "books",
          constraint_name: "books_author_fk",
        },
        expect: "− FK books_author_fk",
      },
    ];
    for (const c of cases) {
      expect(diffOpSummary(c.op)).toBe(c.expect);
    }
  });
});
