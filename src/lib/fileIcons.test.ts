import { FileArchive, FileImage, FileJson, FileText } from "lucide-react";
import { describe, expect, it } from "vitest";
import { fileCategory, fileExtension, fileIcon } from "./fileIcons";

describe("fileExtension", () => {
  it("returns the lowercase extension", () => {
    expect(fileExtension("path/to/Report.PDF")).toBe("pdf");
    expect(fileExtension("a/b/c/image.JPEG")).toBe("jpeg");
  });

  it("handles keys with no extension", () => {
    expect(fileExtension("folder/README")).toBe("");
    expect(fileExtension("noext")).toBe("");
  });

  it("treats dotfiles as having no extension", () => {
    expect(fileExtension(".gitignore")).toBe("");
    expect(fileExtension("dir/.env")).toBe("");
  });

  it("ignores a trailing slash (folder markers)", () => {
    expect(fileExtension("some/folder/")).toBe("");
  });
});

describe("fileCategory", () => {
  it("classifies by extension", () => {
    expect(fileCategory("a/b/photo.png")).toBe("image");
    expect(fileCategory("doc.pdf")).toBe("pdf");
    expect(fileCategory("bundle.zip")).toBe("archive");
    expect(fileCategory("clip.mp4")).toBe("video");
    expect(fileCategory("song.mp3")).toBe("audio");
    expect(fileCategory("data.csv")).toBe("spreadsheet");
    expect(fileCategory("main.rs")).toBe("code");
    expect(fileCategory("notes.md")).toBe("text");
  });

  it("falls back to the content type when the extension is unknown", () => {
    expect(fileCategory("blob", "image/png")).toBe("image");
    expect(fileCategory("blob", "application/pdf")).toBe("pdf");
    expect(fileCategory("blob", "video/webm")).toBe("video");
    expect(fileCategory("blob", "text/plain")).toBe("text");
  });

  it("defaults to other", () => {
    expect(fileCategory("mystery.bin")).toBe("other");
    expect(fileCategory("blob")).toBe("other");
  });
});

describe("fileIcon", () => {
  it("maps categories to icons", () => {
    expect(fileIcon("photo.png")).toBe(FileImage);
    expect(fileIcon("archive.zip")).toBe(FileArchive);
    expect(fileIcon("notes.md")).toBe(FileText);
  });

  it("gives JSON its own glyph", () => {
    expect(fileIcon("config.json")).toBe(FileJson);
  });
});
