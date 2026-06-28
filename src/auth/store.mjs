import { readFileSync } from "node:fs";

// Mercadona stores the logged-in user (including the API access token) in
// localStorage under "MO-user". Playwright's storage_state.json captures that,
// so we read the token straight out of it — no separate token endpoint.

function decodeJwt(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

export function loadSession(statePath) {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const origin = state.origins?.find((o) => o.origin.includes("mercadona.es"));
  const entry = origin?.localStorage?.find((e) => e.name === "MO-user");
  if (!entry) throw new Error('No "MO-user" in storage_state — run the login first.');
  const mo = JSON.parse(entry.value);
  if (!mo.token) throw new Error('No access token in "MO-user".');
  return {
    token: mo.token,
    refreshToken: mo.refreshToken,
    customerId: mo.uuid,
    exp: decodeJwt(mo.token).exp,
  };
}

export function tokenStatus(session) {
  const now = Math.floor(Date.now() / 1000);
  const secondsLeft = session.exp - now;
  return { valid: secondsLeft > 0, secondsLeft, daysLeft: secondsLeft / 86400 };
}
