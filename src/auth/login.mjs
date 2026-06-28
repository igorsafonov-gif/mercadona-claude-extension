import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadSession, tokenStatus } from "./store.mjs";

const BASE = "https://tienda.mercadona.es";

// Open a real Chrome window, let the user sign in (handling any 2FA/SCA), and
// capture their authenticated session. We wait until the page makes its first
// authenticated `/api/` request (i.e. login succeeded) before saving state.
export async function runLogin(statePath, { timeoutMs = 5 * 60000 } = {}) {
  const { chromium } = await import("playwright-core");
  mkdirSync(dirname(statePath), { recursive: true });
  const channel = process.env.MERCADONA_BROWSER_CHANNEL || "chrome";
  let browser;
  try {
    browser = await chromium.launch({ headless: false, channel });
  } catch (e) {
    throw new Error(`Couldn't open ${channel} — make sure Google Chrome is installed. (${e.message.split("\n")[0]})`);
  }
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    let bearer = null;
    page.on("request", (req) => {
      if (!req.url().includes("/api/")) return;
      const auth = req.headers()["authorization"];
      if (auth?.startsWith("Bearer ")) bearer = auth.slice(7);
    });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    const start = Date.now();
    while (!bearer && Date.now() - start < timeoutMs) await page.waitForTimeout(1000);
    if (!bearer) throw new Error("No Mercadona login detected in time — run login again and sign in.");
    await context.storageState({ path: statePath });
  } finally {
    await browser.close();
  }
  const s = loadSession(statePath);
  return { customerId: s.customerId, daysLeft: tokenStatus(s).daysLeft };
}
