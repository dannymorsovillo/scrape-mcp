#!/usr/bin/env node
// Entry point: runs the MCP server on stdio and a WebSocket listener that the
// Chrome extension pushes captured calls into.

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EndpointRegistry } from "./registry.js";
import type { AgentInfo, Endpoint, EndpointsMessage, InboundMessage } from "./types.js";

const WS_PORT = Number(process.env.SCRAPE_MCP_WS_PORT ?? 8787);

// stdout carries the MCP protocol — everything else goes to stderr.
function log(...args: unknown[]): void {
  console.error("[scrape-mcp]", ...args);
}

const registry = new EndpointRegistry();

// The MCP client that spawned us, once it has completed the handshake. stdio
// admits exactly one, fixed for the life of the process — so this is a fact to
// report, not a choice anything gets to make.
let agent: AgentInfo | undefined;

let wss: WebSocketServer | undefined;

/** Everything the popup renders. The same shape whether pushed or requested. */
function state(): EndpointsMessage {
  return { type: "endpoints", endpoints: registry.list(), agent };
}

// Captures arrive in bursts (one per keystroke), so coalesce the pushes
// rather than re-sending the whole list for each one.
let pending: ReturnType<typeof setTimeout> | undefined;
function broadcast(): void {
  if (!wss || pending) return;
  const server = wss;
  pending = setTimeout(() => {
    pending = undefined;
    const msg = JSON.stringify(state());
    for (const client of server.clients) {
      if (client.readyState === client.OPEN) client.send(msg);
    }
  }, 200);
}

// --- WebSocket ingest -------------------------------------------------------

function startWebSocket(): WebSocketServer {
  wss = new WebSocketServer({ port: WS_PORT });

  wss.on("connection", (socket) => {
    log("extension connected");

    socket.on("message", (raw) => {
      let msg: InboundMessage;
      try {
        msg = JSON.parse(raw.toString()) as InboundMessage;
      } catch {
        log("dropped malformed message");
        return;
      }

      switch (msg.type) {
        case "hello":
          log(`extension v${msg.extensionVersion ?? "unknown"}`);
          break;
        case "capture": {
          const id = registry.ingest(msg.data);
          if (id) log(`captured ${msg.data.method} ${msg.data.url} -> ${id}`);
          broadcast();
          break;
        }
        case "clear":
          registry.clear();
          log("registry cleared by extension");
          broadcast();
          break;
        case "list":
          socket.send(JSON.stringify(state()));
          break;
      }
    });

    socket.on("close", () => log("extension disconnected"));
  });

  wss.on("listening", () => log(`listening for captures on ws://localhost:${WS_PORT}`));

  wss.on("error", (err: NodeJS.ErrnoException) => {
    // Without the port we can never receive a capture, so the registry would
    // stay empty forever while still answering tool calls — an agent reading
    // from this process would silently see nothing. Fail loudly instead.
    if (err.code === "EADDRINUSE") {
      log(
        `FATAL: port ${WS_PORT} is already in use — another scrape-mcp server is ` +
          `probably still running. Kill it (lsof -ti :${WS_PORT} | xargs kill) and retry.`,
      );
    } else {
      log("FATAL: websocket error:", err);
    }
    process.exit(1);
  });

  return wss;
}

// --- MCP tools --------------------------------------------------------------

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/**
 * Collected datasets land in <repo>/output. Resolved from this file rather than
 * the working directory: the client spawns this server, so cwd is whatever the
 * client happened to be in and "./output" would land somewhere different for
 * each one. Gitignored — the rows are real data, not something to commit.
 */
const OUTPUT_DIR = resolve(fileURLToPath(import.meta.url), "../../../output");

// A walk issues real requests carrying the user's session, so it gets a leash
// the single-shot replay doesn't need: a cap, and a pause between pages.
const WALK_PAGE_LIMIT = 100;
const WALK_DEFAULT_PAGES = 10;
const WALK_DELAY_MS = 200;

/** Placeholders templatePath() produces: {id}, {uuid}, {hash}. */
const PLACEHOLDER_RE = /^\{[a-z]+\}$/;

/**
 * True if `pathname` is `template` with its placeholders filled in: same segment
 * count, literal segments equal, placeholders matching any one non-empty segment.
 *
 * Replay carries the endpoint's real credentials, so without this an agent could
 * name a harmless captured endpoint and send the cookie anywhere else on the
 * origin — /admin/users off the back of a search call.
 */
function pathMatchesTemplate(pathname: string, template: string): boolean {
  let decoded: string;
  try {
    // new URL() percent-encodes the braces, so /x/{id} arrives as /x/%7Bid%7D.
    decoded = decodeURIComponent(pathname);
  } catch {
    return false; // malformed escape — nothing legitimate looks like this
  }
  const got = decoded.split("/");
  const want = template.split("/");
  if (got.length !== want.length) return false;
  return want.every((seg, i) => (PLACEHOLDER_RE.test(seg) ? got[i] !== "" : got[i] === seg));
}

/**
 * Resolve an agent-supplied path against an endpoint, enforcing both guards.
 * Shared by replay and walk so a looping tool can't sidestep them.
 */
function resolveUrl(ep: Endpoint, path?: string): { url: URL } | { error: string } {
  const url = new URL(path ?? ep.pathTemplate, ep.origin);
  if (url.origin !== ep.origin) {
    return {
      error:
        `path must stay on ${ep.origin} (got ${url.origin}). ` +
        `Pass a path like ${ep.pathTemplate}, not a full URL.`,
    };
  }
  if (!pathMatchesTemplate(url.pathname, ep.pathTemplate)) {
    return {
      error:
        `path ${url.pathname} doesn't match this endpoint's ${ep.pathTemplate}. ` +
        `Fill in the placeholders; don't change the shape. ` +
        `Use list_endpoints to find the endpoint you want.`,
    };
  }
  return { url };
}

/** Walk a dot path ("data.items") into a parsed body. */
function getByPath(obj: unknown, path: string): unknown {
  if (path === "") return obj;
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined),
      obj,
    );
}

/**
 * Locate the array of rows in a response. With no itemsPath, guess: the body
 * itself, else its first array-valued key. The guess is reported back so the
 * agent can correct it rather than silently collect the wrong field.
 */
function findItems(body: unknown, itemsPath?: string): { items: unknown[]; path: string } | undefined {
  if (itemsPath !== undefined) {
    const found = getByPath(body, itemsPath);
    return Array.isArray(found) ? { items: found, path: itemsPath } : undefined;
  }
  if (Array.isArray(body)) return { items: body, path: "" };
  if (body && typeof body === "object") {
    for (const [key, value] of Object.entries(body)) {
      if (Array.isArray(value)) return { items: value, path: key };
    }
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildServer(): McpServer {
  const server = new McpServer({ name: "scrape-mcp", version: "0.1.0" });

  server.registerTool(
    "list_endpoints",
    {
      description:
        "List the API endpoints captured from the browser so far, most frequently seen first. " +
        "Returns summaries only — call get_endpoint for schemas and sample bodies.",
      inputSchema: {
        host: z
          .string()
          .optional()
          .describe("Only return endpoints whose host contains this substring."),
      },
    },
    async ({ host }) => {
      let endpoints = registry.list();
      if (host) {
        const needle = host.toLowerCase();
        endpoints = endpoints.filter((e) => e.origin.toLowerCase().includes(needle));
      }
      return json({ count: endpoints.length, endpoints });
    },
  );

  server.registerTool(
    "get_endpoint",
    {
      description:
        "Get the full detail for one captured endpoint: inferred request/response JSON Schemas, " +
        "sample bodies, observed status codes, and which auth headers it requires.",
      inputSchema: {
        id: z.string().describe("Endpoint id from list_endpoints."),
      },
    },
    async ({ id }) => {
      const ep = registry.get(id);
      if (!ep) {
        return {
          content: [{ type: "text" as const, text: `No endpoint with id ${id}.` }],
          isError: true,
        };
      }
      // authHeaderNames is safe to expose; the values stay in the registry.
      return json(ep);
    },
  );

  server.registerTool(
    "replay_endpoint",
    {
      description:
        "Re-issue a captured request, reusing the auth headers observed on the original call. " +
        "Use this to explore an API's behaviour with different parameters.",
      inputSchema: {
        id: z.string().describe("Endpoint id from list_endpoints."),
        path: z
          .string()
          .optional()
          .describe("Concrete path to hit, filling in any {id}/{uuid} placeholders. Defaults to the template."),
        query: z.record(z.string()).optional().describe("Query parameters."),
        body: z.unknown().optional().describe("JSON request body."),
      },
    },
    async ({ id, path, query, body }) => {
      const ep = registry.get(id);
      if (!ep) {
        return {
          content: [{ type: "text" as const, text: `No endpoint with id ${id}.` }],
          isError: true,
        };
      }

      const resolved = resolveUrl(ep, path);
      if ("error" in resolved) return toolError(resolved.error);
      const { url } = resolved;

      for (const [k, v] of Object.entries(query ?? {})) {
        url.searchParams.set(k, v);
      }
      // Re-attach credentials that travelled in the query string. Applied last
      // so the agent can't override them with a value of its own.
      for (const [k, v] of Object.entries(registry.getAuthQuery(id))) {
        url.searchParams.set(k, v);
      }

      const headers: Record<string, string> = { ...registry.getAuthHeaders(id) };
      if (body !== undefined) headers["content-type"] = "application/json";

      try {
        const res = await fetch(url, {
          method: ep.method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        return json({
          status: res.status,
          contentType: res.headers.get("content-type"),
          body: text.slice(0, 50_000),
        });
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Request failed: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "walk_endpoint",
    {
      description:
        "Collect a whole paginated dataset from one endpoint and write it to a file. " +
        "Issues one request per page, following the pagination parameter you name, and stops " +
        "on an empty page, a non-2xx response, or maxPages. Returns a summary and the file " +
        "path — not the rows — so a large dataset never enters the conversation. " +
        "Before using this, check whether the endpoint accepts a larger page size " +
        "(hitsPerPage, per_page, limit): one big request beats fifty small ones.",
      inputSchema: {
        id: z.string().describe("Endpoint id from list_endpoints."),
        path: z.string().optional().describe("Concrete path, if the template has placeholders."),
        query: z
          .record(z.string())
          .optional()
          .describe("Query parameters held constant across pages (filters, search terms)."),
        pageParam: z
          .string()
          .default("page")
          .describe("Query parameter to increment per page, e.g. page, offset, skip."),
        startPage: z.number().int().default(0).describe("First value for pageParam."),
        pageStep: z
          .number()
          .int()
          .default(1)
          .describe("Amount to add per page. Use 1 for page numbers, the page size for offsets."),
        maxPages: z
          .number()
          .int()
          .optional()
          .describe(`Stop after this many requests. Default ${WALK_DEFAULT_PAGES}, hard cap ${WALK_PAGE_LIMIT}.`),
        itemsPath: z
          .string()
          .optional()
          .describe('Dot path to the array of rows, e.g. "hits" or "data.items". Guessed if omitted.'),
      },
    },
    async ({ id, path, query, pageParam, startPage, pageStep, maxPages, itemsPath }) => {
      const ep = registry.get(id);
      if (!ep) return toolError(`No endpoint with id ${id}.`);

      const resolved = resolveUrl(ep, path);
      if ("error" in resolved) return toolError(resolved.error);

      const limit = Math.min(maxPages ?? WALK_DEFAULT_PAGES, WALK_PAGE_LIMIT);
      const rows: unknown[] = [];
      let pages = 0;
      let usedItemsPath = itemsPath ?? "";
      let stopped = `reached maxPages (${limit})`;

      for (let i = 0; i < limit; i++) {
        const url = new URL(resolved.url.href);
        for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
        url.searchParams.set(pageParam, String(startPage + i * pageStep));
        // Credentials last, so the agent can't override them with its own value.
        for (const [k, v] of Object.entries(registry.getAuthQuery(id))) url.searchParams.set(k, v);

        let res: Response;
        try {
          res = await fetch(url, { method: ep.method, headers: { ...registry.getAuthHeaders(id) } });
        } catch (err) {
          stopped = `request failed on page ${i}: ${String(err)}`;
          break;
        }
        // Stop rather than push through a 429 — this is hitting a real service
        // with the user's session, and retrying is how accounts get locked.
        if (!res.ok) {
          stopped = `HTTP ${res.status} on page ${i}`;
          break;
        }

        let body: unknown;
        try {
          body = JSON.parse(await res.text());
        } catch {
          stopped = `page ${i} was not JSON`;
          break;
        }

        const found = findItems(body, itemsPath);
        if (!found) {
          stopped = itemsPath
            ? `no array at itemsPath "${itemsPath}" on page ${i}`
            : `couldn't find an array of rows on page ${i} — pass itemsPath`;
          break;
        }
        usedItemsPath = found.path;
        if (found.items.length === 0) {
          stopped = `empty page at ${i}`;
          break;
        }
        rows.push(...found.items);
        pages++; // counted after the empty check, so it means pages that had rows

        if (i < limit - 1) await sleep(WALK_DELAY_MS);
      }

      if (rows.length === 0) {
        return toolError(`Collected nothing: ${stopped}. Try get_endpoint to check the response shape.`);
      }

      const slug = `${ep.host}${ep.pathTemplate}`.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
      const file = join(OUTPUT_DIR, `${slug}-${Date.now()}.json`);
      await mkdir(OUTPUT_DIR, { recursive: true });
      await writeFile(
        file,
        JSON.stringify(
          { endpoint: `${ep.method} ${ep.origin}${ep.pathTemplate}`, collectedAt: new Date().toISOString(), pages, rows: rows.length, items: rows },
          null,
          2,
        ),
      );
      log(`walk ${ep.pathTemplate}: ${rows.length} rows over ${pages} pages -> ${file}`);

      return json({
        pages,
        rows: rows.length,
        file,
        itemsPath: usedItemsPath,
        stopped,
        sample: rows[0],
      });
    },
  );

  server.registerTool(
    "clear_endpoints",
    {
      description: "Discard every captured endpoint and start fresh.",
      inputSchema: {},
    },
    async () => {
      const n = registry.size();
      registry.clear();
      return json({ cleared: n });
    },
  );

  return server;
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  startWebSocket();
  const server = buildServer();

  // clientInfo only exists once the client has sent `initialize`, so the name
  // can't be read at connect time — it has to be picked up from the handshake.
  server.server.oninitialized = () => {
    const info = server.server.getClientVersion();
    agent = info ? { name: info.name, version: info.version } : undefined;
    log(`agent attached: ${info ? `${info.name} ${info.version ?? ""}`.trim() : "unidentified"}`);
    broadcast();
  };

  server.server.onclose = () => {
    agent = undefined;
    broadcast();
  };

  await server.connect(new StdioServerTransport());
  log("MCP server ready on stdio");
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
