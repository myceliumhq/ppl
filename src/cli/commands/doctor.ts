import {
  addSubcommand,
  CliError,
  type Command,
  EXIT_CODES,
  requireConfig,
  runDoctorChecks,
} from "@myceliumhq/toolkit";
import { unwrapCli } from "../api.js";
import { CONFIG_SPEC, resolveClientHandle } from "../config.js";

export function registerDoctor(program: Command): void {
  addSubcommand(program, "doctor")
    .summary("Check config and connectivity.")
    .action(async () => {
      const code = await runDoctorChecks([
        {
          name: "config (PAPERLESS_URL, PAPERLESS_TOKEN)",
          run: async () => {
            requireConfig(CONFIG_SPEC);
          },
        },
        {
          name: "connect to paperless-ngx API",
          run: async () => {
            const { client } = resolveClientHandle();
            await unwrapCli(
              client.GET("/api/documents/", {
                params: { query: { page_size: 1, fields: ["id"] } },
              }),
            );
          },
        },
      ]);
      if (code !== EXIT_CODES.ok) {
        throw new CliError("doctor checks failed", { exitCode: code });
      }
    });
}
