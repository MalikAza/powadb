import { describe, expect, it } from "vitest";
import {
  CONNECTION_COLORS,
  connectionFormSchema,
  dbKindSchema,
  diagramDocSchema,
  diagramEdgeSchema,
  diagramTableSchema,
  folderFormSchema,
  KIND_DEFAULTS,
  newTableFormSchema,
  ROOT_FOLDER_SENTINEL,
  snippetSaveSchema,
  themeModeSchema,
} from "./schemas";

describe("dbKindSchema", () => {
  it("accepts known kinds", () => {
    expect(dbKindSchema.parse("postgres")).toBe("postgres");
    expect(dbKindSchema.parse("mysql")).toBe("mysql");
    expect(dbKindSchema.parse("sqlite")).toBe("sqlite");
  });

  it("rejects unknown kinds", () => {
    expect(() => dbKindSchema.parse("mongodb")).toThrow();
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

describe("connectionFormSchema sqlite branch", () => {
  const sqliteValid = {
    name: "local.db",
    kind: "sqlite" as const,
    host: "",
    port: 0,
    database: "/tmp/local.db",
    username: "",
    ssl: false,
    folder_id: null,
    color: null,
  };

  it("accepts sqlite with empty host/username/port and a non-empty database path", () => {
    const parsed = connectionFormSchema.parse(sqliteValid);
    expect(parsed.kind).toBe("sqlite");
    expect(parsed.database).toBe("/tmp/local.db");
  });

  it("rejects sqlite without a database file path", () => {
    expect(() => connectionFormSchema.parse({ ...sqliteValid, database: "   " })).toThrow();
    expect(() => connectionFormSchema.parse({ ...sqliteValid, database: "" })).toThrow();
  });
});

describe("connectionFormSchema wireguard branch", () => {
  const base = {
    name: "wg pg",
    kind: "postgres" as const,
    host: "h",
    port: 5432,
    database: "d",
    username: "u",
    ssl: false,
    folder_id: null,
    color: null,
    wg_enabled: true,
  };

  it("requires a wg_config when wireguard is enabled", () => {
    expect(() => connectionFormSchema.parse({ ...base, wg_config: "" })).toThrow();
    expect(() => connectionFormSchema.parse({ ...base, wg_config: "   " })).toThrow();
  });

  it("requires both [Interface] and [Peer] sections", () => {
    expect(() =>
      connectionFormSchema.parse({ ...base, wg_config: "[Interface]\nkey=val" }),
    ).toThrow();
    expect(() => connectionFormSchema.parse({ ...base, wg_config: "[Peer]\nkey=val" })).toThrow();
  });

  it("accepts a wg_config with both sections", () => {
    const parsed = connectionFormSchema.parse({
      ...base,
      wg_config: "[Interface]\nPrivateKey=x\n[Peer]\nPublicKey=y",
    });
    expect(parsed.wg_enabled).toBe(true);
    expect(parsed.wg_config).toContain("[Peer]");
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
    expect(KIND_DEFAULTS.sqlite.port).toBe(0);
    expect(KIND_DEFAULTS.sqlite.username).toBe("");
  });
});

describe("CONNECTION_COLORS", () => {
  it("starts with a 'none' option whose value is null", () => {
    expect(CONNECTION_COLORS[0]?.name).toBe("none");
    expect(CONNECTION_COLORS[0]?.value).toBeNull();
  });
});

describe("connectionFormSchema ssh branch", () => {
  const base = {
    name: "ssh pg",
    kind: "postgres" as const,
    host: "h",
    port: 5432,
    database: "d",
    username: "u",
    ssl: false,
    folder_id: null,
    color: null,
    ssh_enabled: true,
    ssh_host: "bastion.example.com",
    ssh_port: 22,
    ssh_username: "ubuntu",
  };

  it("rejects when SSH host is empty", () => {
    expect(() => connectionFormSchema.parse({ ...base, ssh_host: "  " })).toThrow(/SSH host/);
  });

  it("rejects when SSH username is empty", () => {
    expect(() => connectionFormSchema.parse({ ...base, ssh_username: "  " })).toThrow(/username/i);
  });

  it("rejects when SSH port is below 1", () => {
    // ssh_port has a min(0) at the union/pipe stage, so 0 passes the pipe but
    // the superRefine fires the "Port must be ≥ 1" issue.
    expect(() => connectionFormSchema.parse({ ...base, ssh_port: 0 })).toThrow(/Port/);
  });

  it("requires ssh_password when auth method is password", () => {
    expect(() =>
      connectionFormSchema.parse({
        ...base,
        ssh_auth_method: "password",
        ssh_password: "",
      }),
    ).toThrow(/SSH password/);
  });

  it("requires ssh_key_path when auth method is key (default)", () => {
    expect(() =>
      connectionFormSchema.parse({ ...base, ssh_auth_method: "key", ssh_key_path: "  " }),
    ).toThrow(/private key/i);
  });

  it("accepts a valid SSH key configuration", () => {
    const parsed = connectionFormSchema.parse({
      ...base,
      ssh_auth_method: "key",
      ssh_key_path: "/home/me/.ssh/id_ed25519",
    });
    expect(parsed.ssh_enabled).toBe(true);
    expect(parsed.ssh_key_path).toBe("/home/me/.ssh/id_ed25519");
  });

  it("rejects enabling both WireGuard and SSH", () => {
    expect(() =>
      connectionFormSchema.parse({
        ...base,
        ssh_auth_method: "key",
        ssh_key_path: "/k",
        wg_enabled: true,
        wg_config: "[Interface]\n[Peer]\nfoo",
      }),
    ).toThrow(/WireGuard or SSH/);
  });
});

describe("newTableFormSchema", () => {
  const validColumn = {
    name: "id",
    dataType: "bigserial",
    nullable: false,
    isPk: true,
    defaultValue: "",
  };

  it("accepts a table with at least one PK column", () => {
    const parsed = newTableFormSchema.parse({
      name: "users",
      columns: [validColumn],
    });
    expect(parsed.name).toBe("users");
    expect(parsed.columns).toHaveLength(1);
  });

  it("requires at least one PK column", () => {
    expect(() =>
      newTableFormSchema.parse({
        name: "users",
        columns: [{ ...validColumn, isPk: false }],
      }),
    ).toThrow(/primary key/);
  });

  it("rejects duplicate column names (case-insensitive, trimmed)", () => {
    expect(() =>
      newTableFormSchema.parse({
        name: "users",
        columns: [
          validColumn,
          { name: "ID", dataType: "int", nullable: false, isPk: false, defaultValue: "" },
        ],
      }),
    ).toThrow(/Duplicate column name/);
  });

  it("requires a non-empty table name and at least one column", () => {
    expect(() => newTableFormSchema.parse({ name: "", columns: [validColumn] })).toThrow();
    expect(() => newTableFormSchema.parse({ name: "users", columns: [] })).toThrow();
  });
});

describe("diagram schemas", () => {
  const col = {
    id: "col-1",
    name: "id",
    dataType: "bigint",
    nullable: false,
    isPk: true,
    isFk: false,
    defaultValue: null,
  };
  const table = {
    id: "t-1",
    schema: "public",
    name: "users",
    columns: [col],
    position: { x: 0, y: 0 },
  };
  const edge = {
    id: "e-1",
    name: null,
    source: "t-1",
    target: "t-2",
    sourceColumns: ["id"],
    targetColumns: ["user_id"],
    onUpdate: null,
    onDelete: null,
  };

  it("parses a valid diagram doc", () => {
    const parsed = diagramDocSchema.parse({
      version: 1,
      engine: "postgres",
      tables: [table],
      edges: [edge],
    });
    expect(parsed.tables[0]?.name).toBe("users");
    expect(parsed.edges[0]?.sourceColumns).toEqual(["id"]);
  });

  it("requires version === 1", () => {
    expect(() =>
      diagramDocSchema.parse({ version: 2, engine: "postgres", tables: [], edges: [] }),
    ).toThrow();
  });

  it("requires at least one column on a table", () => {
    expect(() => diagramTableSchema.parse({ ...table, columns: [] })).toThrow(/column/i);
  });

  it("requires at least one column on each side of an edge", () => {
    expect(() => diagramEdgeSchema.parse({ ...edge, sourceColumns: [] })).toThrow();
    expect(() => diagramEdgeSchema.parse({ ...edge, targetColumns: [] })).toThrow();
  });
});
