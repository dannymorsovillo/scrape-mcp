#!/usr/bin/env node
// Entry point: runs the MCP server on stdio and a WebSocket listener that the
// Chrome extension pushes captured calls into.

import { WebSocketServer } from "ws";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EndpointRegistry } from "./registry.js";
import type { AgentInfo, EndpointsMessage, InboundMessage } from "./types.js";

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

      // `path` is agent-controlled, and new URL() lets an absolute or
      // protocol-relative value ("https://evil.com", "//evil.com") discard the
      // base entirely — which would send this endpoint's credentials to a host
      // we never captured. Resolve first, then check where we actually landed.
      const url = new URL(path ?? ep.pathTemplate, ep.origin);
      if (url.origin !== ep.origin) {
        return toolError(
          `path must stay on ${ep.origin} (got ${url.origin}). ` +
            `Pass a path like ${ep.pathTemplate}, not a full URL.`,
        );
      }
      // Checked against the resolved pathname, not the raw input, so that
      // traversal like /a/../admin is normalized before it's compared.
      if (!pathMatchesTemplate(url.pathname, ep.pathTemplate)) {
        return toolError(
          `path ${url.pathname} doesn't match this endpoint's ${ep.pathTemplate}. ` +
            `Fill in the placeholders; don't change the shape. ` +
            `Use list_endpoints to find the endpoint you want.`,
        );
      }

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
