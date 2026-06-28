import { loadSession, tokenStatus } from "../auth/store.mjs";

const BASE = "https://tienda.mercadona.es";
const API = `${BASE}/api`;
const ALGOLIA = {
  host: "https://7uzjkl1dj0-dsn.algolia.net",
  app: "7UZJKL1DJ0",
  key: "9d8f2e39e90df472b4f2e559a116fe17", // public, search-only key
};

export class AuthError extends Error {}

export class MercadonaClient {
  constructor(statePath) {
    this.statePath = statePath;
    this.session = loadSession(statePath);
    this.warehouse = null;
  }

  reload() {
    this.session = loadSession(this.statePath);
    return this;
  }

  get customerId() {
    return this.session.customerId;
  }

  tokenStatus() {
    return tokenStatus(this.session);
  }

  async #get(path) {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${this.session.token}`, Accept: "application/json" },
    });
    const wh = res.headers.get("x-customer-wh");
    if (wh) this.warehouse = wh;
    if (res.status === 401) throw new AuthError("Mercadona session expired (401). Run the `login` tool to sign in again.");
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return res.json();
  }

  getCustomer() {
    return this.#get(`/customers/${this.customerId}/`);
  }

  getCart() {
    return this.#get(`/customers/${this.customerId}/cart/`);
  }

  getOrders(page = 1) {
    return this.#get(`/customers/${this.customerId}/orders/?page=${page}`);
  }

  getOrder(orderId) {
    return this.#get(`/customers/${this.customerId}/orders/${orderId}/`);
  }

  getMyRegulars(kind = "precision") {
    return this.#get(`/customers/${this.customerId}/recommendations/myregulars/${kind}/`);
  }

  getProduct(productId) {
    return this.#get(`/products/${productId}/`);
  }

  getAddresses() {
    return this.#get(`/customers/${this.customerId}/addresses/`);
  }

  getSlots(addressId) {
    return this.#get(`/customers/${this.customerId}/addresses/${addressId}/slots/`);
  }

  // Read-modify-write on the cart's optimistic-lock `version`. `mutate(lines)`
  // receives the current lines as [{product_id, quantity, sources}] and returns
  // the desired lines. Retries once on a version conflict.
  async #mutateCart(mutate) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cart = await this.getCart();
      const lines = (cart.lines || []).map((l) => ({
        product_id: String(l.product?.id ?? l.product_id),
        quantity: l.quantity,
        sources: l.sources ?? [],
      }));
      const next = mutate(lines).filter((l) => l.quantity > 0);
      const res = await fetch(`${API}/customers/${this.customerId}/cart/`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.session.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: cart.id, version: cart.version, lines: next }),
      });
      if (res.status === 401) throw new AuthError("Mercadona session expired (401). Run the `login` tool to sign in again.");
      if ([409, 412, 422].includes(res.status)) continue;
      if (!res.ok) throw new Error(`PUT cart -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    }
    throw new Error("Cart changed concurrently (version conflict) — try again.");
  }

  addToCart(productId, quantity = 1) {
    const id = String(productId);
    return this.#mutateCart((lines) => {
      const line = lines.find((l) => l.product_id === id);
      if (line) line.quantity += quantity;
      else lines.push({ product_id: id, quantity, sources: [] });
      return lines;
    });
  }

  setQuantity(productId, quantity) {
    const id = String(productId);
    return this.#mutateCart((lines) => {
      if (quantity <= 0) return lines.filter((l) => l.product_id !== id);
      const line = lines.find((l) => l.product_id === id);
      if (line) line.quantity = quantity;
      else lines.push({ product_id: id, quantity, sources: [] });
      return lines;
    });
  }

  removeFromCart(productId) {
    const id = String(productId);
    return this.#mutateCart((lines) => lines.filter((l) => l.product_id !== id));
  }

  // Add several products in ONE read-modify-write (for reorder). items: [{product_id, quantity}]
  addManyToCart(items) {
    return this.#mutateCart((lines) => {
      for (const { product_id, quantity } of items) {
        const id = String(product_id);
        const line = lines.find((l) => l.product_id === id);
        if (line) line.quantity += quantity;
        else lines.push({ product_id: id, quantity, sources: [] });
      }
      return lines;
    });
  }

  // The actual line items of a past order ("prepared" = what was picked), paginated.
  async getOrderLines(orderId) {
    const all = [];
    for (let page = 1; page <= 25; page++) {
      const data = await this.#get(`/customers/${this.customerId}/orders/${orderId}/lines/prepared/?page=${page}`);
      const results = data.results || [];
      all.push(...results);
      if (!data.next_page || results.length === 0) break;
    }
    return all;
  }

  async getLatestOrderId() {
    const data = await this.getOrders(1);
    const o = (data.results || [])[0];
    return o?.order_id ?? o?.id ?? null;
  }

  async ensureWarehouse() {
    if (!this.warehouse) await this.getCustomer();
    return this.warehouse;
  }

  async search(query, { hitsPerPage = 24 } = {}) {
    const wh = (await this.ensureWarehouse())?.toLowerCase();
    const index = `products_prod_${wh}_es`;
    const res = await fetch(`${ALGOLIA.host}/1/indexes/${index}/query`, {
      method: "POST",
      headers: {
        "X-Algolia-Application-Id": ALGOLIA.app,
        "X-Algolia-API-Key": ALGOLIA.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ params: `query=${encodeURIComponent(query)}&hitsPerPage=${hitsPerPage}` }),
    });
    if (!res.ok) throw new Error(`Algolia search -> ${res.status}`);
    return res.json();
  }
}

function productImage(p, size = 400) {
  const src = p?.thumbnail || p?.photos?.[0]?.regular || p?.photos?.[0]?.thumbnail;
  if (!src) return undefined;
  return `${src.split("?")[0]}?fit=crop&w=${size}&h=${size}`;
}

export function compactProduct(p, extra = {}) {
  if (!p) return null;
  const pi = p.price_instructions || {};
  const image = productImage(p);
  return {
    id: p.id,
    name: p.display_name,
    ...(p.brand ? { brand: p.brand } : {}),
    ...(p.packaging ? { packaging: p.packaging } : {}),
    ...(pi.unit_price ? { price: `€${pi.unit_price}` } : {}),
    ...(pi.reference_price ? { unit_price: `€${pi.reference_price}/${pi.reference_format}` } : {}),
    ...(pi.is_pack && pi.total_units ? { pack: `${pi.total_units}×${pi.unit_size}${pi.size_format ?? ""}` } : {}),
    ...(image ? { image } : {}),
    ...(p.share_url ? { url: p.share_url } : {}),
    ...extra,
  };
}

export function compactOrder(o) {
  return {
    order_id: o.order_id ?? o.id,
    date: o.start_date,
    status: o.status_ui ?? o.status,
    total: o.summary?.total ?? o.price,
    items: o.products_count,
  };
}

export function compactCart(c) {
  return {
    cart_id: c.id,
    version: c.version,
    products_count: c.products_count,
    total: c.summary?.total,
    lines: (c.lines || []).flatMap((l) => l.products ?? [l]).map((l) => {
      const p = l.product ?? l;
      const pi = p.price_instructions || {};
      const image = productImage(p);
      return {
        product_id: l.product_id ?? p.id,
        name: p.display_name,
        quantity: l.quantity,
        ...(pi.unit_price ? { price: `€${pi.unit_price}` } : {}),
        ...(image ? { image } : {}),
        ...(p.share_url ? { url: p.share_url } : {}),
      };
    }),
  };
}

export function lineIsAvailable(l) {
  return l.product?.published !== false && !l.product?.unavailable_from;
}

export function compactOrderLine(l) {
  return {
    product_id: l.product_id ?? l.product?.id,
    name: l.product?.display_name,
    quantity: l.ordered_quantity,
    ...(l.prepared_quantity !== l.ordered_quantity ? { prepared: l.prepared_quantity } : {}),
    ...(l.total_prepared_price ? { price: `€${l.total_prepared_price}` } : {}),
    ...(productImage(l.product) ? { image: productImage(l.product) } : {}),
    ...(l.product?.share_url ? { url: l.product.share_url } : {}),
    ...(lineIsAvailable(l) ? {} : { unavailable: true }),
  };
}

export function compactSlot(s) {
  return {
    start: s.start ?? s.start_date,
    end: s.end ?? s.end_date,
    available: s.available,
    ...(s.price != null ? { price: `€${s.price}` } : {}),
  };
}
