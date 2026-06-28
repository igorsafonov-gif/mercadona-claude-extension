---
name: mercadona
description: Shop at Mercadona and ALWAYS show products as an HTML artifact. Use whenever the user searches, browses, compares, or asks about any Mercadona grocery products ("options", "show me…"), or wants to fill, review, or reorder their cart. Presents product results as an HTML artifact photo grid (photo, name, price, link) with images embedded as base64 — downloaded and converted via a script, because remote image URLs don't render in the artifact sandbox. Uses the mercadona tools.
---

# Mercadona shopping

When the user asks about ANY Mercadona products (search, browse, compare, "options", "my regulars",
a past order), **ALWAYS present them as an HTML artifact** — a photo grid where each card has the
product photo, name, price, and a link to the product `url`.

**Photos must be base64-embedded.** Get the products from the mercadona tools, then with your code
tool: download each product's `image` URL, convert it to base64 in a script, and embed it as
`<img src="data:image/jpeg;base64,...">`. A remote `http(s)` image URL will NOT render inside the
artifact — only embedded base64 does. Keep to ~12 products. Doing the base64 inside the script keeps
it out of the conversation and renders reliably on the first try.

## Shopping

- You operate the user's REAL Mercadona cart. The user reviews and pays in the Mercadona app — you
  never check out (there is no checkout tool, by design).
- To add an item you first need its `product_id`: call `search_products` (short Spanish term works
  best), pick the best match, then `add_to_cart`. Prefer the house brand "Hacendado" unless asked.
- Weekly shop: `get_my_regulars` (`kind="precision"` = most bought; each has a recommended_quantity).
  Repeat a past shop: `reorder_order` (defaults to the latest order; mention any skipped/unavailable).
- `get_cart` to review and report the running total. `add_to_cart` / `set_quantity` /
  `remove_from_cart` change the real cart but are reversible — just do them, no per-item confirmation.
- Prices are euros; ~€60 delivery minimum — if the cart is under it, tell the user (don't refuse).
- To sign in — or if a tool reports the session expired (a tool says "not signed in") — call the `login`
  tool: a browser window opens, the user signs in (handling any 2FA), and the session is saved. Then retry.
