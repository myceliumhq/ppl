/**
 * Regenerates src/generated/paperless-schema.d.ts from a live paperless-ngx
 * instance's OpenAPI schema. Requires PAPERLESS_URL and PAPERLESS_TOKEN in
 * the environment (or a .env file loaded by the caller).
 */
import { curlToFile, generateTypes } from "./openapi-codegen.js";

const baseUrl = process.env.PAPERLESS_URL;
const token = process.env.PAPERLESS_TOKEN;

if (!baseUrl || !token) {
  console.error("PAPERLESS_URL and PAPERLESS_TOKEN must be set to regenerate types.");
  process.exit(1);
}

const schemaUrl = new URL("/api/schema/", baseUrl).toString();

generateTypes({
  outPath: "src/generated/paperless-schema.d.ts",
  fetchSchema: (tmpDir) =>
    curlToFile(tmpDir, "schema.json", [
      "-fsS",
      "-H",
      `Authorization: Token ${token}`,
      "-H",
      "Accept: application/json",
      schemaUrl,
    ]),
});
