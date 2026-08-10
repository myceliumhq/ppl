import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GenerateTypesOptions {
  /** Where to write the generated .d.ts, relative to the caller's cwd. */
  outPath: string;
  /** Fetches the OpenAPI schema into tmpDir and returns its path. Runs
   * inside the same temp dir generateTypes() cleans up afterward. */
  fetchSchema: (tmpDir: string) => string;
}

// Runs openapi-typescript via `pnpm dlx` in an isolated resolution rather
// than this repo's own TypeScript devDependency, since openapi-typescript's
// codegen only supports typescript ^5.x while this repo builds against the
// latest major.
export function generateTypes(options: GenerateTypesOptions): void {
  const tmpDir = mkdtempSync(join(tmpdir(), "openapi-codegen-"));
  try {
    const schemaPath = options.fetchSchema(tmpDir);
    const result = spawnSync(
      "pnpm",
      ["dlx", "openapi-typescript", schemaPath, "-o", options.outPath],
      {
        stdio: "inherit",
      },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
    console.log(`Wrote ${options.outPath}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Fetched with `curl` rather than `fetch()`: on macOS, Local Network access
// (TCC) is enforced per-binary via Info.plist entitlements, and bare
// node/python3 get silently blocked (EHOSTUNREACH) hitting LAN IPs, while
// curl is exempt. Exits the process on failure rather than throwing, since
// every caller's own error handling was just "print and exit" anyway.
export function curlToFile(tmpDir: string, filename: string, curlArgs: string[]): string {
  const outPath = join(tmpDir, filename);
  const result = spawnSync("curl", [...curlArgs, "-o", outPath], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`curl failed fetching the OpenAPI schema (args: ${curlArgs.join(" ")})`);
    process.exit(result.status ?? 1);
  }
  return outPath;
}
