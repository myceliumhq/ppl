#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createProgram, runProgram } from "@myceliumhq/toolkit";
import { registerDoc } from "./commands/doc.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerSearch } from "./commands/search.js";
import { registerTaxonomyGroup } from "./commands/taxonomy.js";
import { registerUpload } from "./commands/upload.js";

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };

const program = createProgram(
  "ppl",
  "paperless-ngx CLI for agents -- search, read, and manage documents.",
  version,
);
registerSearch(program);
registerDoc(program);
registerUpload(program);
registerTaxonomyGroup(program, "tag", "tag");
registerTaxonomyGroup(program, "correspondent", "correspondent");
registerTaxonomyGroup(program, "doctype", "doctype");
registerDoctor(program);

runProgram(program, process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
