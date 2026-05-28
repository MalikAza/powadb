import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagramDoc } from "./types";

const ipcMock = {
  pickSavePathWithFilter: vi.fn(),
  writeTextFile: vi.fn(),
  generateDiagramDdl: vi.fn(),
};

vi.mock("@/ipc", () => ({
  ipc: ipcMock,
}));

const { exportDocAsJson, exportDocAsSql } = await import("./exportDiagram");

const sampleDoc: DiagramDoc = {
  version: 1,
  engine: "postgres",
  tables: [],
  edges: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exportDocAsJson", () => {
  it("returns false and writes nothing when the user cancels the picker", async () => {
    ipcMock.pickSavePathWithFilter.mockResolvedValueOnce(null);

    const ok = await exportDocAsJson(sampleDoc, "diagram");

    expect(ok).toBe(false);
    expect(ipcMock.writeTextFile).not.toHaveBeenCalled();
  });

  it("writes pretty-printed JSON to the picked path and returns true", async () => {
    ipcMock.pickSavePathWithFilter.mockResolvedValueOnce("/tmp/out.json");
    ipcMock.writeTextFile.mockResolvedValueOnce(undefined);

    const ok = await exportDocAsJson(sampleDoc, "diagram.json");

    expect(ok).toBe(true);
    // Suggested name has its extension stripped before being suffixed with .json.
    expect(ipcMock.pickSavePathWithFilter).toHaveBeenCalledWith("diagram.json", "JSON", ["json"]);
    expect(ipcMock.writeTextFile).toHaveBeenCalledWith(
      "/tmp/out.json",
      JSON.stringify(sampleDoc, null, 2),
    );
  });

  it("strips a variety of recognized extensions before appending .json", async () => {
    ipcMock.pickSavePathWithFilter.mockResolvedValueOnce("/tmp/out.json");
    ipcMock.writeTextFile.mockResolvedValueOnce(undefined);

    await exportDocAsJson(sampleDoc, "schema.SQL");

    expect(ipcMock.pickSavePathWithFilter).toHaveBeenCalledWith("schema.json", "JSON", ["json"]);
  });
});

describe("exportDocAsSql", () => {
  it("returns false when picker is cancelled", async () => {
    ipcMock.pickSavePathWithFilter.mockResolvedValueOnce(null);

    const ok = await exportDocAsSql(sampleDoc, "diagram");

    expect(ok).toBe(false);
    expect(ipcMock.generateDiagramDdl).not.toHaveBeenCalled();
    expect(ipcMock.writeTextFile).not.toHaveBeenCalled();
  });

  it("renders DDL via generateDiagramDdl and writes it to the picked path", async () => {
    ipcMock.pickSavePathWithFilter.mockResolvedValueOnce("/tmp/schema.sql");
    ipcMock.generateDiagramDdl.mockResolvedValueOnce("CREATE TABLE foo();");
    ipcMock.writeTextFile.mockResolvedValueOnce(undefined);

    const ok = await exportDocAsSql(sampleDoc, "schema");

    expect(ok).toBe(true);
    expect(ipcMock.pickSavePathWithFilter).toHaveBeenCalledWith("schema.sql", "SQL", ["sql"]);
    expect(ipcMock.generateDiagramDdl).toHaveBeenCalledWith(
      JSON.stringify(sampleDoc),
      sampleDoc.engine,
    );
    expect(ipcMock.writeTextFile).toHaveBeenCalledWith("/tmp/schema.sql", "CREATE TABLE foo();");
  });
});
