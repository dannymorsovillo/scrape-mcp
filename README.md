# scrape-mcp

Turns the APIs a website uses into tools an AI agent can explore.

A browser extension watches the XHR/fetch calls a page makes and streams them to
a local bridge, which exposes what it learned over MCP. Point it at a site with
no public API docs, click around, and an agent can ask what endpoints exist, what
they return, and replay them with different parameters.

```
Browser tab                Extension             Bridge server          Agent
XHR / fetch --debugger--> background.js --ws--> registry --stdio--> MCP tools
                                        8787    dedupe + schema
```

Requests aren't just logged. They're collapsed into distinct endpoints
(`/users/42/posts` and `/users/43/posts` become one `/users/{id}/posts`), counted,
and a JSON Schema is inferred from the response bodies observed.

## Setup

Requires Node 18+ and a Chromium browser (Chrome, Brave, Edge).

```sh
cd server && npm install && npm run build
```

Load the extension: open `chrome://extensions` (or `brave://extensions`), enable
**Developer mode**, click **Load unpacked**, select the `extension/` folder.

## Running

The server speaks MCP over stdio *and* listens for captures on port 8787. The
registry lives in that process's memory, so **only one instance may run** — a
second exits immediately rather than serve a registry nothing feeds.

**With an agent.** This is a plain stdio MCP server and works with any MCP client
(Claude Code, Claude Desktop, Cursor, Cline, your own). Let the client spawn it:

```jsonc
{
  "mcpServers": {
    "scrape-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/scrape-mcp/server/dist/index.js"]
    }
  }
}
```

The path must be absolute — clients spawn servers with an unpredictable working
directory. Config location varies: `.mcp.json` in the project root for Claude
Code (already here), `claude_desktop_config.json` for Claude Desktop,
`.cursor/mcp.json` for Cursor. Some clients use a `servers` key instead of
`mcpServers`, but `command`/`args` is the same everywhere. Set the
`SCRAPE_MCP_WS_PORT` env var to move off 8787.

**Standalone**, for browsing without an agent — captures log to stderr and appear
in the popup:

```sh
cd server && npm run dev
```

Don't run both: the second instance exits because the first holds the port.

## Capturing

Click the **Scrape MCP** icon, check the dot is green (**Bridge connected**),
hit **Start capturing**, then use the site. Endpoints appear in the popup live.

`hn.algolia.com` is a good test — every keystroke in the search box fires a JSON
API call.

The popup renders the *server's* registry, not its own tally, so it can never
disagree with what the agent sees.

## MCP tools

| Tool | Purpose |
|---|---|
| `list_endpoints` | Everything found, most-seen first. Optional `host` filter. |
| `get_endpoint` | One endpoint in full: schemas, sample bodies, statuses. |
| `replay_endpoint` | Re-issue a request with your captured credentials. |
| `clear_endpoints` | Empty the registry. |

## Credentials

Captured requests carry live session credentials, so they're treated as a one-way
boundary. Values are held privately in the registry and **never** serialized to
the agent. Agents see names and a `requiresAuth` flag:

```jsonc
{
  "queryParams": ["x-algolia-agent"],      // ordinary params
  "authQueryNames": ["x-algolia-api-key"], // name only, value withheld
  "authHeaderNames": ["cookie"],           // name only, value withheld
  "requiresAuth": true
}
```

Both auth headers (`authorization`, `cookie`, `x-api-key`, …) and credentials in
the query string (`?api_key=`, `?access_token=`, vendor-prefixed variants) are
covered. It's enforced by the type system, not by redaction: `Endpoint` has no
field to hold a value.

The exception is `replay_endpoint`, which re-attaches real credentials to re-issue
a request. **An agent calling it acts as you.** Bear that in mind on logged-in
sites.

## Gotchas

- **Capture is per-tab**, and the popup acts on whichever tab is active when you
  click the icon. Clicking **Start** from another tab arms *that* tab.
- **DevTools conflicts** — one debugger client per tab, so **Start** fails if
  DevTools is open on it. The popup shows the error.
- **Captures are lost on restart.** In-memory only; nothing is written to disk.
- **Reloading the extension detaches the debugger.** Hit **Start** again.
- **Only XHR and fetch** are captured — static pages produce nothing.
- **Numeric path segments become `{id}`**, so a version prefix like `/1/indexes/`
  templates to `/{id}/indexes/`.
- Chrome shows a **"started debugging this browser"** banner while capturing.
  It's mandatory for the debugger API; closing it stops capture.

## Troubleshooting

**"Bridge offline"** — no server running, or something else holds the port
(`lsof -i :8787`). The extension reconnects on its own within ~3s.

**Port already in use** — a previous server is still alive:
`lsof -ti :8787 | xargs kill`

**Connected but nothing captured** — the debugger isn't attached where you think.
Ask the browser, from the extension's service worker console
(`chrome://extensions` → **service worker**):

```js
chrome.debugger.getTargets().then(t => console.log(t.filter(x => x.attached)))
```

**MCP tools missing** — most clients only read config at startup, so restart
after editing. Check the path is absolute, and rebuild (`npm run build`) after
changing `src/` — the config points at `dist/`.

## Layout

```
extension/       background.js  debugger capture + bridge socket
                 popup.html/js  status, start/stop, live endpoint list
server/src/      index.ts       MCP tools + WebSocket listener
                 registry.ts    dedupe, path templating, credential boundary
                 schema.ts      JSON Schema inference
                 types.ts       wire protocol + domain types
```

## Status

Early. Capture, dedup, schema inference, and the credential boundary work
end-to-end. Not yet built: persistence, multi-tab capture, and handling for
credentials in path segments or request bodies.
