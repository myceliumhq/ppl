import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import entry from "./index.js";

// Guards against the class of bug fixed here: index.ts registered
// paperless_grep_document/paperless_get_document_range via api.registerTool(),
// but openclaw.plugin.json's contracts.tools list -- which OpenClaw actually
// uses to decide what's exposed to the agent -- was never updated to
// include them, so both tools were silently unavailable at runtime despite
// being fully implemented and tested.
//
// This calls the plugin's real register() (from index.ts) against a fake
// api, the same as OpenClaw itself does at startup, rather than re-deriving
// the tool list by importing the tool factory functions directly. An
// earlier version of this test did exactly that, and it was a lie: it never
// touched index.ts, so it would keep passing even if index.ts forgot to
// call api.registerTool() for a tool -- the exact bug this test exists to
// catch. Verified the current version does catch it: temporarily removing
// one api.registerTool(...) line from index.ts's register() fails this
// test; the old version did not.
describe("openclaw.plugin.json contracts.tools", () => {
  it("matches every tool index.ts actually registers", () => {
    const registered: string[] = [];
    const api = {
      pluginConfig: { baseUrl: "https://paperless.example.com", apiToken: "test-token" },
      registerTool: (tool: { name: string }) => {
        registered.push(tool.name);
      },
    } as unknown as OpenClawPluginApi;

    // OpenClawPluginDefinition types `register` as optional, but this
    // plugin's own entry always provides one -- a missing register() here
    // would itself be a real bug worth failing loudly on, not something to
    // silently no-op past with a bare `?.`.
    if (!entry.register) throw new Error("test setup: entry.register is not defined");
    entry.register(api);

    // Length checks first: a Set-only comparison can't see a duplicate
    // registration (registering the same tool twice) or a duplicate manifest
    // entry, since both collapse away once wrapped in a Set.
    expect(registered).toHaveLength(manifest.contracts.tools.length);
    expect(new Set(registered)).toEqual(new Set(manifest.contracts.tools));
  });
});
