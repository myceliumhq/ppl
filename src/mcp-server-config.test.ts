import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStandaloneConfig, readTransportConfig } from "./mcp-server-config.js";

describe("readStandaloneConfig", () => {
  it("throws a clear error when PAPERLESS_BASE_URL is missing", () => {
    expect(() => readStandaloneConfig({ PAPERLESS_API_TOKEN: "t" })).toThrow(
      "PAPERLESS_BASE_URL environment variable is required",
    );
  });

  it("throws a clear error when PAPERLESS_API_TOKEN is missing", () => {
    expect(() =>
      readStandaloneConfig({ PAPERLESS_BASE_URL: "https://paperless.example.com" }),
    ).toThrow("PAPERLESS_API_TOKEN environment variable is required");
  });

  it("strips a trailing slash from baseUrl", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com/",
      PAPERLESS_API_TOKEN: "t",
    });
    expect(config.baseUrl).toBe("https://paperless.example.com");
  });

  it("leaves semanticSearch undefined when no semantic env vars are set", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
    });
    expect(config.semanticSearch).toBeUndefined();
  });

  it("returns { enabled: false } when semantic search is explicitly disabled", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
      PAPERLESS_SEMANTIC_SEARCH_ENABLED: "false",
    });
    expect(config.semanticSearch).toEqual({ enabled: false });
  });

  it("builds a full embedding config from PAPERLESS_EMBEDDING_* vars, parsing dimensions as a number", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
      PAPERLESS_EMBEDDING_BASE_URL: "https://openrouter.ai/api/v1",
      PAPERLESS_EMBEDDING_API_KEY: "key",
      PAPERLESS_EMBEDDING_MODEL: "text-embedding-3-small",
      PAPERLESS_EMBEDDING_DIMENSIONS: "1536",
    });
    expect(config.semanticSearch).toEqual({
      indexPath: undefined,
      embedding: {
        provider: undefined,
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "key",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
    });
  });

  it("passes provider: local through only when explicitly set to a recognized value", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
      PAPERLESS_EMBEDDING_PROVIDER: "local",
    });
    expect(config.semanticSearch?.embedding?.provider).toBe("local");
  });

  it("ignores an unrecognized PAPERLESS_EMBEDDING_PROVIDER value", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
      PAPERLESS_EMBEDDING_PROVIDER: "gemini",
    });
    expect(config.semanticSearch?.embedding?.provider).toBeUndefined();
  });

  it("carries indexPath through even with no embedding config set", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
      PAPERLESS_SEMANTIC_INDEX_PATH: "/data/index.db",
    });
    expect(config.semanticSearch).toEqual({ indexPath: "/data/index.db", embedding: undefined });
  });

  describe("<VAR>_FILE Docker secrets", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "paperless-mcp-config-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const writeSecret = (name: string, contents: string): string => {
      const file = join(dir, name);
      writeFileSync(file, contents);
      return file;
    };

    it("reads apiToken from PAPERLESS_API_TOKEN_FILE, trimming the trailing newline", () => {
      const config = readStandaloneConfig({
        PAPERLESS_BASE_URL: "https://paperless.example.com",
        PAPERLESS_API_TOKEN_FILE: writeSecret("api-token", "secret-api-token\n"),
      });
      expect(config.apiToken).toBe("secret-api-token");
    });

    it("still strips a trailing slash from a baseUrl read from PAPERLESS_BASE_URL_FILE", () => {
      const config = readStandaloneConfig({
        PAPERLESS_BASE_URL_FILE: writeSecret("base-url", "https://paperless.example.com/\n"),
        PAPERLESS_API_TOKEN: "t",
      });
      expect(config.baseUrl).toBe("https://paperless.example.com");
    });

    it("prefers the _FILE variant when both it and the plain env var are set", () => {
      const config = readStandaloneConfig({
        PAPERLESS_BASE_URL: "https://paperless.example.com",
        PAPERLESS_API_TOKEN: "plain",
        PAPERLESS_API_TOKEN_FILE: writeSecret("api-token", "from-file"),
      });
      expect(config.apiToken).toBe("from-file");
    });
  });

  it("leaves readOnly false when PAPERLESS_READ_ONLY is unset", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
    });
    expect(config.readOnly).toBe(false);
  });

  // Read-only is armed by exactly "true"; an unrecognized non-empty value is a
  // startup error (fail-closed) rather than a silent read-write default -- the
  // right failure direction for a security switch aimed at HTTP exposure.
  it("leaves readOnly false when PAPERLESS_READ_ONLY is empty", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
      PAPERLESS_READ_ONLY: "",
    });
    expect(config.readOnly).toBe(false);
  });

  for (const value of ["1", "yes", "TRUE", "on", "false"]) {
    it(`throws on the non-literal PAPERLESS_READ_ONLY value [${value}]`, () => {
      expect(() =>
        readStandaloneConfig({
          PAPERLESS_BASE_URL: "https://paperless.example.com",
          PAPERLESS_API_TOKEN: "t",
          PAPERLESS_READ_ONLY: value,
        }),
      ).toThrow(`PAPERLESS_READ_ONLY must be exactly "true" or empty`);
    });
  }

  it("sets readOnly when PAPERLESS_READ_ONLY is exactly the string true", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
      PAPERLESS_READ_ONLY: "true",
    });
    expect(config.readOnly).toBe(true);
  });

  it("parses PAPERLESS_SEMANTIC_SEARCH_ENABLED strictly, rejecting unrecognized values", () => {
    expect(() =>
      readStandaloneConfig({
        PAPERLESS_BASE_URL: "https://paperless.example.com",
        PAPERLESS_API_TOKEN: "t",
        PAPERLESS_SEMANTIC_SEARCH_ENABLED: "yes",
      }),
    ).toThrow('PAPERLESS_SEMANTIC_SEARCH_ENABLED must be "true" or "false" (got "yes")');
  });

  it("treats an empty PAPERLESS_SEMANTIC_SEARCH_ENABLED as unset (Docker/k8s artifact)", () => {
    const config = readStandaloneConfig({
      PAPERLESS_BASE_URL: "https://paperless.example.com",
      PAPERLESS_API_TOKEN: "t",
      PAPERLESS_SEMANTIC_SEARCH_ENABLED: "",
    });
    expect(config.semanticSearch).toBeUndefined();
  });

  it("rejects a non-integer PAPERLESS_EMBEDDING_DIMENSIONS instead of producing NaN", () => {
    expect(() =>
      readStandaloneConfig({
        PAPERLESS_BASE_URL: "https://paperless.example.com",
        PAPERLESS_API_TOKEN: "t",
        PAPERLESS_EMBEDDING_DIMENSIONS: "abc",
      }),
    ).toThrow('PAPERLESS_EMBEDDING_DIMENSIONS must be a positive integer (got "abc")');
  });

  it("rejects non-decimal PAPERLESS_EMBEDDING_DIMENSIONS (hex/exponential)", () => {
    expect(() =>
      readStandaloneConfig({
        PAPERLESS_BASE_URL: "https://paperless.example.com",
        PAPERLESS_API_TOKEN: "t",
        PAPERLESS_EMBEDDING_DIMENSIONS: "1e3",
      }),
    ).toThrow('PAPERLESS_EMBEDDING_DIMENSIONS must be a positive integer (got "1e3")');
  });
});

describe("readTransportConfig", () => {
  it("defaults to stdio", () => {
    expect(readTransportConfig({})).toEqual({ transport: "stdio" });
  });

  it("accepts an explicit stdio value", () => {
    expect(readTransportConfig({ MCP_TRANSPORT: "stdio" })).toEqual({ transport: "stdio" });
  });

  it("treats an empty MCP_TRANSPORT as unset (Docker/k8s artifact)", () => {
    expect(readTransportConfig({ MCP_TRANSPORT: "" })).toEqual({ transport: "stdio" });
  });

  it("throws for an unrecognized MCP_TRANSPORT value instead of falling back to stdio", () => {
    expect(() => readTransportConfig({ MCP_TRANSPORT: "websocket" })).toThrow(
      'Unknown MCP_TRANSPORT value "websocket"',
    );
  });

  it("switches to http with a default port of 3000", () => {
    expect(readTransportConfig({ MCP_TRANSPORT: "http" })).toEqual({
      transport: "http",
      port: 3000,
      host: "127.0.0.1",
    });
  });

  it("reads a custom port for http", () => {
    expect(readTransportConfig({ MCP_TRANSPORT: "http", MCP_PORT: "8080" })).toEqual({
      transport: "http",
      port: 8080,
      host: "127.0.0.1",
    });
  });

  it("defaults the http bind host to the loopback interface", () => {
    expect(readTransportConfig({ MCP_TRANSPORT: "http" })).toMatchObject({ host: "127.0.0.1" });
  });

  it("binds to an explicit MCP_HOST when set (with a host allowlist for non-loopback)", () => {
    expect(
      readTransportConfig({
        MCP_TRANSPORT: "http",
        MCP_HOST: "0.0.0.0",
        MCP_ALLOWED_HOSTS: "mcp.grotz.io",
      }),
    ).toMatchObject({ host: "0.0.0.0", allowedHosts: ["mcp.grotz.io"] });
    // An empty value stays inert (Docker/k8s artifact) and keeps loopback.
    expect(readTransportConfig({ MCP_TRANSPORT: "http", MCP_HOST: "" })).toEqual({
      transport: "http",
      port: 3000,
      host: "127.0.0.1",
    });
  });

  it("refuses a non-loopback bind with no MCP_ALLOWED_HOSTS (fail-closed, no app auth)", () => {
    expect(() => readTransportConfig({ MCP_TRANSPORT: "http", MCP_HOST: "0.0.0.0" })).toThrow(
      "MCP_HOST is bound to non-loopback interface",
    );
  });

  it("rejects invalid MCP_ALLOWED_HOSTS entries (scheme, port, whitespace)", () => {
    expect(() =>
      readTransportConfig({ MCP_TRANSPORT: "http", MCP_ALLOWED_HOSTS: "mcp.grotz.io:8443" }),
    ).toThrow("MCP_ALLOWED_HOSTS contains an invalid host entry");
    expect(() =>
      readTransportConfig({ MCP_TRANSPORT: "http", MCP_ALLOWED_HOSTS: "https://mcp.grotz.io" }),
    ).toThrow("MCP_ALLOWED_HOSTS contains an invalid host entry");
    expect(() =>
      readTransportConfig({ MCP_TRANSPORT: "http", MCP_ALLOWED_HOSTS: "mcp.grotz.io/path" }),
    ).toThrow("MCP_ALLOWED_HOSTS contains an invalid host entry");
  });

  it("trims surrounding whitespace from MCP_HOST", () => {
    expect(
      readTransportConfig({
        MCP_TRANSPORT: "http",
        MCP_HOST: " 0.0.0.0 ",
        MCP_ALLOWED_HOSTS: "mcp.grotz.io",
      }),
    ).toMatchObject({ host: "0.0.0.0" });
  });

  it("rejects an MCP_HOST containing whitespace (fail-closed like MCP_PORT)", () => {
    expect(() => readTransportConfig({ MCP_TRANSPORT: "http", MCP_HOST: "0.0.0.0 3000" })).toThrow(
      "MCP_HOST must be a host/IP without whitespace",
    );
  });

  it("reads a comma-separated MCP_ALLOWED_HOSTS allowlist (trimmed, de-duplicated)", () => {
    expect(
      readTransportConfig({
        MCP_TRANSPORT: "http",
        MCP_ALLOWED_HOSTS: "mcp.grotz.io, 10.0.0.5, mcp.grotz.io",
      }),
    ).toMatchObject({ allowedHosts: ["mcp.grotz.io", "10.0.0.5"] });
  });

  it("treats an empty or whitespace-only MCP_ALLOWED_HOSTS as unset (loopback-only)", () => {
    expect(readTransportConfig({ MCP_TRANSPORT: "http", MCP_ALLOWED_HOSTS: "" })).toEqual({
      transport: "http",
      port: 3000,
      host: "127.0.0.1",
    });
    // Whitespace-only (no real hostnames) is likewise treated as unset -- the
    // resulting object must carry no allowedHosts at all, not ["  "].
    expect(readTransportConfig({ MCP_TRANSPORT: "http", MCP_ALLOWED_HOSTS: "  ,  " })).toEqual({
      transport: "http",
      port: 3000,
      host: "127.0.0.1",
    });
  });

  it("throws when MCP_PORT is not a valid integer", () => {
    expect(() => readTransportConfig({ MCP_TRANSPORT: "http", MCP_PORT: "abc" })).toThrow(
      "MCP_PORT must be an integer between 1 and 65535",
    );
    expect(() => readTransportConfig({ MCP_TRANSPORT: "http", MCP_PORT: "12.5" })).toThrow(
      "MCP_PORT must be an integer between 1 and 65535",
    );
    expect(() => readTransportConfig({ MCP_TRANSPORT: "http", MCP_PORT: "70000" })).toThrow(
      "MCP_PORT must be an integer between 1 and 65535",
    );
  });

  it("rejects non-decimal MCP_PORT (hex/exponential)", () => {
    expect(() => readTransportConfig({ MCP_TRANSPORT: "http", MCP_PORT: "0x1F90" })).toThrow(
      "MCP_PORT must be an integer between 1 and 65535",
    );
  });

  it("treats an empty MCP_PORT as the default 3000 (Docker/k8s artifact)", () => {
    expect(readTransportConfig({ MCP_TRANSPORT: "http", MCP_PORT: "" })).toEqual({
      transport: "http",
      port: 3000,
      host: "127.0.0.1",
    });
  });
});
