#!/usr/bin/env node
// Validates every *.powadb-theme.json in ./themes against the powadb-theme/v1
// schema. Exits non-zero on any failure so CI can gate on it.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEMES_DIR = join(__dirname, "..", "themes");

const THEME_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "sidebar",
  "sidebar-foreground",
  "sidebar-border",
  "sidebar-accent",
  "sidebar-accent-foreground",
];

function validate(file, raw) {
  const errors = [];
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    errors.push(`invalid JSON: ${e.message}`);
    return errors;
  }
  if (!obj || typeof obj !== "object") {
    errors.push("not a JSON object");
    return errors;
  }
  if (obj.schema !== "powadb-theme/v1") {
    errors.push(`schema must be "powadb-theme/v1" (got ${JSON.stringify(obj.schema)})`);
  }
  if (typeof obj.name !== "string" || !obj.name.trim()) {
    errors.push("name must be a non-empty string");
  }
  if (obj.base !== "light" && obj.base !== "dark") {
    errors.push(`base must be "light" or "dark" (got ${JSON.stringify(obj.base)})`);
  }
  if (typeof obj.radius !== "string") {
    errors.push("radius must be a string");
  }
  if (!obj.colors || typeof obj.colors !== "object") {
    errors.push("colors must be an object");
    return errors;
  }
  for (const token of THEME_TOKENS) {
    const v = obj.colors[token];
    if (typeof v !== "string" || !v.trim()) {
      errors.push(`missing or empty color "${token}"`);
    }
  }
  const known = new Set(THEME_TOKENS);
  for (const key of Object.keys(obj.colors)) {
    if (!known.has(key)) errors.push(`unknown color key "${key}"`);
  }
  return errors;
}

const files = readdirSync(THEMES_DIR)
  .filter((f) => f.endsWith(".powadb-theme.json"))
  .sort();

if (files.length === 0) {
  console.error(`no *.powadb-theme.json files found in ${THEMES_DIR}`);
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const path = join(THEMES_DIR, file);
  const raw = readFileSync(path, "utf8");
  const errors = validate(file, raw);
  if (errors.length === 0) {
    console.log(`ok    ${file}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${file}`);
    for (const e of errors) console.error(`        - ${e}`);
  }
}

console.log("");
if (failed > 0) {
  console.error(`${failed} theme(s) failed validation`);
  process.exit(1);
}
console.log(`${files.length} theme(s) ok`);
