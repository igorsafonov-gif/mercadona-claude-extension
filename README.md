# Mercadona for Claude

Shop your [Mercadona](https://tienda.mercadona.es) online groceries by talking to Claude.

This is an [MCP](https://modelcontextprotocol.io) server that drives **your own** authenticated
Mercadona session. Claude can search the catalog scoped to your delivery area, read your purchase
history and "my regulars," and add, change, or remove items in your **real cart** — so you and Claude
fill it together. Products are presented as a photo grid.

> **You stay in control of payment.** There is no checkout or payment tool, by design. Claude fills
> the cart; you review and pay in the Mercadona app, where Strong Customer Authentication happens.

It ships in two forms from the same source:

- a **Claude Desktop extension** (`.mcpb`) — `manifest.json`
- a **Claude Code plugin** — `.claude-plugin/plugin.json` + `.mcp.json` + `skills/`

> Independent project. Not affiliated with, endorsed by, or sponsored by Mercadona. macOS-focused.

## Tools

| Tool | What it does |
| --- | --- |
| `get_shopping_guide` | The shopping playbook. Read first. |
| `auth_status` | Whether the session is valid and how long the token lasts. |
| `login` | Open a browser to sign in (handles 2FA); saves the session locally. |
| `search_products` | Find products + ids in your delivery area. |
| `get_product` | Details for a single product by id. |
| `get_cart` | The current real cart: items, quantities, total. |
| `get_my_regulars` | What you usually buy (`precision` = most bought, `recall` = also bought). |
| `get_purchase_history` | Past orders: date, total, status, item count. |
| `get_order_items` | Items in a past order, without adding anything. |
| `get_delivery_slots` | Available delivery windows for your address. |
| `add_to_cart` | Add a product by id (increments if present). |
| `set_quantity` | Set the exact quantity (`0` removes). |
| `remove_from_cart` | Remove a product entirely. |
| `reorder_order` | "Buy again" — add a whole past order in one step. |

## Requirements

- **Node.js ≥ 18**
- **Google Chrome** installed (the `login` tool opens it via Playwright's `chrome` channel)

## Build

```bash
npm install
npm run build      # bundles src/ -> dist/server.mjs with esbuild
```

`playwright-core` is kept external (it stays in `node_modules`); everything else is bundled into
`dist/server.mjs`.

## Run / install

### As a local MCP server

```bash
npm install && npm run build
node dist/server.mjs
```

Point any MCP client at `node /path/to/dist/server.mjs`. For Claude Desktop's config:

```json
{
  "mcpServers": {
    "mercadona": {
      "command": "node",
      "args": ["/absolute/path/to/mercadona-claude-extension/dist/server.mjs"],
      "env": { "MERCADONA_BROWSER_CHANNEL": "chrome" }
    }
  }
}
```

### As a Claude Code plugin

After `npm install && npm run build`, add this directory as a plugin. The `.mcp.json` wires up the
server via `${CLAUDE_PLUGIN_ROOT}` and `skills/mercadona/SKILL.md` ships the shopping playbook.

### As a Claude Desktop extension (`.mcpb`)

```bash
npm run pack       # builds dist/, then packs a .mcpb via @anthropic-ai/mcpb
```

Then open the resulting `.mcpb` with Claude Desktop. (The bundle includes `dist/` and the
production `node_modules`, i.e. `playwright-core`.)

## Signing in

Run the `login` tool (or just ask Claude to log in). A Chrome window opens at the Mercadona store;
sign in and complete any 2FA. The extension waits until it sees your first authenticated request,
then saves the session to:

```
~/.mercadona/storage_state.json
```

This file holds your Mercadona auth and **never leaves your machine**. It is git-ignored here — do
not commit it. Tokens last a few days; re-run `login` when `auth_status` says it has expired.

Override the location with `MERCADONA_STATE_PATH`, or the browser with `MERCADONA_BROWSER_CHANNEL`
(default `chrome`).

## How it works

- **Auth** (`src/auth`): Mercadona stores the logged-in user — including the API access token — in
  `localStorage` under `MO-user`. The `login` flow captures Playwright `storageState`, and
  `store.mjs` reads the token straight out of it. No separate token endpoint.
- **API** (`src/mercadona/api.mjs`): a thin client over `tienda.mercadona.es/api`. Catalog search
  goes through Mercadona's public, search-only Algolia index (scoped to your warehouse). Cart writes
  are a read-modify-write against the cart's optimistic-lock `version`, retried once on conflict.
- **Server** (`src/server.mjs`): registers the tools over stdio and turns expired-token / not-signed-in
  errors into friendly messages.

## License

MIT © Igor Safonov
