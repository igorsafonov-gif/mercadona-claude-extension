import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  MercadonaClient,
  AuthError,
  compactProduct,
  compactOrder,
  compactCart,
  compactOrderLine,
  compactSlot,
  lineIsAvailable,
} from "./mercadona/api.mjs";
import { runLogin } from "./auth/login.mjs";
import SKILL from "../skills/mercadona/SKILL.md";

const STATE_PATH = process.env.MERCADONA_STATE_PATH || path.join(os.homedir(), ".mercadona", "storage_state.json");

let client;
function getClient() {
  if (!client) client = new MercadonaClient(STATE_PATH);
  else client.reload();
  return client;
}

const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

// Wrap a handler so it gets a fresh-reloaded client and turns the common
// failure modes (expired token, missing session file) into friendly messages.
function tool(handler) {
  return async (args) => {
    try {
      return await handler(args, getClient());
    } catch (e) {
      if (e instanceof AuthError) return fail(e.message);
      if (e?.code === "ENOENT") return fail("Not signed in yet. Run the `login` tool first.");
      return fail(`Error: ${e.message}`);
    }
  };
}

const INSTRUCTIONS = `Before showing products or building a cart, call get_shopping_guide once and follow it — it is the full Mercadona shopping playbook.

When the user asks about ANY products, ALWAYS present them in an HTML artifact — a photo grid (photo, name, price, linked to "url"). Convert each product's "image" to base64 via a script and embed it as <img src="data:image/jpeg;base64,...">; a remote image URL won't render in the artifact.

You operate the user's REAL Mercadona grocery cart so you can fill it together. The user always reviews and pays in the Mercadona app — you never check out (there is no checkout tool, by design).

How to shop:
- If a tool says "not signed in" or the session expired, call the login tool — a browser opens, the user signs in (handling any 2FA), and the session is saved; then retry the action.
- To add an item you first need its product_id. Call search_products with a short term (Spanish works best, e.g. "leche", "tomate frito", "papel higiénico"), pick the best match, then call add_to_cart with that id. NEVER invent a product_id.
- Mercadona's house brand is "Hacendado" — prefer it unless the user asks for a specific brand.
- For a weekly shop, call get_my_regulars (kind="precision" = most bought) and suggest from it; each item has a recommended_quantity.
- To repeat a previous shop, use reorder_order (defaults to the most recent order) — it adds that order's items to the cart in one step. Mention any items it skipped as unavailable. Use get_order_items to show what a past order contained without adding anything.
- Use get_cart to review progress and report the running total. add_to_cart / set_quantity / remove_from_cart change the real cart but are reversible, so just do them — no need to ask permission per item.
- get_purchase_history shows past orders (dates, totals). get_delivery_slots shows delivery options.

Conventions:
- product_id is a string; quantity is a whole number. For produce sold by piece (e.g. bananas) the quantity is the number of pieces.
- Prices are euros. There is a ~€60 delivery minimum: if the cart total is under it, tell the user they need to add more to reach the minimum — don't refuse, just inform.
- The catalog is already scoped to the user's delivery area; you never set a location.

When the user lists several items, search + add them one at a time, then summarise the cart with its total. When finished, tell them the cart is ready to review and pay in the Mercadona app. To sign in or re-authenticate, call the login tool — it opens a browser for the user to sign in.`;

const server = new McpServer({ name: "mercadona", version: "0.1.0" }, { instructions: INSTRUCTIONS });

server.registerTool(
  "get_shopping_guide",
  {
    title: "Shopping guide (read first)",
    description: "Return the Mercadona shopping playbook: how to present products (ALWAYS as a photo-grid artifact), fill and review the real cart, use 'my regulars', and reorder past shops. Call this once at the start of any Mercadona task — before searching or adding to the cart — and follow it.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: SKILL }] })
);

server.registerTool(
  "auth_status",
  {
    title: "Auth status",
    description: "Check whether the Mercadona session is valid and how long the token lasts.",
    inputSchema: {},
  },
  tool(async (_args, c) => {
    const s = c.tokenStatus();
    return json({ signed_in: s.valid, days_left: Number(s.daysLeft.toFixed(1)), customer_id: c.customerId });
  })
);

server.registerTool(
  "login",
  {
    title: "Log in to Mercadona",
    description: "Open a browser window to sign in to Mercadona. The user logs in (and handles any 2FA/SCA); the session is then saved so all other tools work. Call this when not signed in, or when a tool reports the session expired.",
    inputSchema: {},
  },
  async () => {
    try {
      const r = await runLogin(STATE_PATH);
      return { content: [{ type: "text", text: `Signed in to Mercadona — session saved (token valid ~${Math.round(r.daysLeft)} days). You can shop now.` }] };
    } catch (e) {
      const msg = /Cannot find (package|module) '?playwright/.test(e.message) ? "the browser component (Playwright) isn't available to this server yet." : e.message;
      return { content: [{ type: "text", text: `Login failed: ${msg}` }], isError: true };
    }
  }
);

server.registerTool(
  "search_products",
  {
    title: "Search products",
    description: "Find a product and its id (needed before add_to_cart), scoped to the user's delivery area. Use a short term; prefer the house brand 'Hacendado' unless asked otherwise. Returns matches with ids and prices.",
    inputSchema: {
      query: z.string().describe("Search text, e.g. 'leche semidesnatada' or 'olive oil'"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 24)"),
    },
  },
  tool(async ({ query, limit }, c) => {
    const data = await c.search(query, { hitsPerPage: limit ?? 24 });
    return json({ query, total: data.nbHits, results: (data.hits || []).map((h) => compactProduct(h)) });
  })
);

server.registerTool(
  "get_product",
  {
    title: "Get product",
    description: "Get details for a single product by id.",
    inputSchema: { product_id: z.string().describe("Product id, e.g. '10381'") },
  },
  tool(async ({ product_id }, c) => json(compactProduct(await c.getProduct(product_id))))
);

server.registerTool(
  "get_cart",
  {
    title: "Get cart",
    description: "Show the current real shopping cart (items, quantities, total).",
    inputSchema: {},
  },
  tool(async (_args, c) => json(compactCart(await c.getCart())))
);

server.registerTool(
  "get_my_regulars",
  {
    title: "My regulars",
    description: "Products you usually buy. kind='precision' = most bought; kind='recall' = also bought.",
    inputSchema: {
      kind: z.enum(["precision", "recall"]).optional().describe("Default 'precision'"),
    },
  },
  tool(async ({ kind }, c) => {
    const data = await c.getMyRegulars(kind ?? "precision");
    const items = (data.results || []).map((it) => compactProduct(it.product, { recommended_quantity: it.recommended_quantity }));
    return json({ kind: kind ?? "precision", count: items.length, items });
  })
);

server.registerTool(
  "get_purchase_history",
  {
    title: "Purchase history",
    description: "List past orders (date, total, status, item count). Page is 1-based.",
    inputSchema: { page: z.number().int().min(1).optional().describe("Default 1") },
  },
  tool(async ({ page }, c) => {
    const data = await c.getOrders(page ?? 1);
    return json({ page: page ?? 1, orders: (data.results || []).map(compactOrder) });
  })
);

server.registerTool(
  "get_order_items",
  {
    title: "Order items",
    description: "List the products in a past order (without adding anything). Defaults to the most recent order if order_id is omitted.",
    inputSchema: {
      order_id: z.union([z.string(), z.number()]).optional().describe("Order id from get_purchase_history; default = latest order"),
    },
  },
  tool(async ({ order_id }, c) => {
    const id = order_id ?? (await c.getLatestOrderId());
    if (!id) return fail("No orders found on this account.");
    const lines = await c.getOrderLines(id);
    return json({ order_id: id, count: lines.length, items: lines.map(compactOrderLine) });
  })
);

server.registerTool(
  "get_delivery_slots",
  {
    title: "Delivery slots",
    description: "Available delivery slots. Uses your first address if address_id is omitted.",
    inputSchema: { address_id: z.string().optional().describe("Optional address id") },
  },
  tool(async ({ address_id }, c) => {
    let addressId = address_id;
    if (!addressId) {
      const addrs = await c.getAddresses();
      addressId = addrs.results?.[0]?.id;
      if (!addressId) return fail("No delivery address found on this account.");
    }
    const data = await c.getSlots(addressId);
    return json({ address_id: addressId, slots: (data.results || []).map(compactSlot) });
  })
);

server.registerTool(
  "add_to_cart",
  {
    title: "Add to cart",
    description: "Add a product to the real cart by id (get the id from search_products or get_my_regulars first). If already present, increases the quantity. Returns the updated cart with its total.",
    inputSchema: {
      product_id: z.string().describe("Product id from search_products/get_my_regulars, e.g. '10922'"),
      quantity: z.number().int().min(1).optional().describe("How many to add (default 1)"),
    },
  },
  tool(async ({ product_id, quantity }, c) => json(compactCart(await c.addToCart(product_id, quantity ?? 1))))
);

server.registerTool(
  "set_quantity",
  {
    title: "Set quantity",
    description: "Set the exact quantity of a product in the cart. Quantity 0 removes it. Returns the updated cart.",
    inputSchema: {
      product_id: z.string().describe("Product id"),
      quantity: z.number().int().min(0).describe("Exact quantity (0 removes)"),
    },
  },
  tool(async ({ product_id, quantity }, c) => json(compactCart(await c.setQuantity(product_id, quantity))))
);

server.registerTool(
  "remove_from_cart",
  {
    title: "Remove from cart",
    description: "Remove a product from the cart entirely. Returns the updated cart.",
    inputSchema: { product_id: z.string().describe("Product id") },
  },
  tool(async ({ product_id }, c) => json(compactCart(await c.removeFromCart(product_id))))
);

server.registerTool(
  "reorder_order",
  {
    title: "Buy again (reorder)",
    description: "Add all items from a past order to the cart in one step (a 'buy again'). Defaults to the most recent order. Skips items no longer available and reports them. Returns the updated cart.",
    inputSchema: { order_id: z.union([z.string(), z.number()]).optional().describe("Order id from get_purchase_history; default = latest order") },
  },
  tool(async ({ order_id }, c) => {
    const id = order_id ?? (await c.getLatestOrderId());
    if (!id) return fail("No orders found on this account.");
    const lines = await c.getOrderLines(id);
    const available = lines.filter(lineIsAvailable);
    const skipped = lines.filter((l) => !lineIsAvailable(l)).map((l) => l.product?.display_name);
    const items = available.map((l) => ({ product_id: l.product_id ?? l.product?.id, quantity: l.ordered_quantity }));
    const cart = await c.addManyToCart(items);
    return json({ reordered_from: id, added: items.length, skipped_unavailable: skipped, cart: compactCart(cart) });
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("mercadona MCP server ready (read + cart writes; no checkout)");
