import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/**
 * Authorization on the QuickBooks routers.
 *
 * `quickBooksAuth` is the only middleware these fifteen routers are mounted
 * with, and its old gate was a hand-maintained list of path prefixes that
 * failed OPEN: a path missing from the list got `next()`. Five were missing,
 * among them `PUT /api/customers/:id` — the list held `/customers` and
 * `/api/invoices`, but never `/api/customers`.
 *
 * What that did NOT cost is authentication. Seven routers mounted at "/" ahead
 * of the QuickBooks block (`manualGl`, `keyReports`, `workspacePageState` and
 * others) each call `router.use(requireAuth)` with no path, which in Express
 * authenticates every request passing through the router — not just the ones it
 * defines. So an unauthenticated request never reached these handlers, and the
 * 401 assertions below already passed before this gate was rewritten. They are
 * kept because that wall is load-bearing and entirely accidental: it lives in
 * routers that this program will delete, and the day `manualGl` goes, the
 * routes behind it lose their authentication silently.
 *
 * What the gap did cost is the company check. `checkQBAuth` is what calls
 * `canAccessCompany`, and it was skipped for those five routes; none of the
 * handlers check company access themselves, and `extractClientId` takes the
 * company from `?clientId=`, `x-client-id` or the Referer. So a signed-in user
 * of one company could name another company's id and be served its data.
 *
 * The invariant that prevents all of this is structural, and is the first test
 * below: the gate is DERIVED from the router, so every route a router defines
 * is gated by construction, and a route added tomorrow is gated the day it is
 * written.
 */

/**
 * Every QuickBooks router, discovered rather than listed.
 *
 * A hand-maintained list is the same failure this middleware had: it goes stale
 * silently. This one went stale within a day — three routers were deleted and
 * the list still named them, so the suite failed to load rather than reporting
 * a gap. Reading the directory means a new router joins this test by existing.
 */
function quickbooksRouters() {
  const root = fileURLToPath(new URL("../routes/quickbooks", import.meta.url));
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) out.push(full);
    }
  };
  walk(root);
  // `token.js` is mounted on its own in `app.js`, ahead of the financial
  // routers and WITHOUT this gate, because the OAuth handshake cannot require
  // a session: Intuit redirects a browser to `/api/auth/callback` with no
  // credentials, and the handler authenticates from the signed `state`. Its
  // routes are asserted separately below rather than swept in here.
  return out.filter((f) => !f.endsWith("/token.js")).sort();
}

const SOME_UUID = "11111111-2222-3333-4444-555555555555";

/** Every (method, path) the financial routers define, params filled in. */
function definedRoutes() {
  const out = [];
  for (const file of quickbooksRouters()) {
    const router = require(file);
    if (!router || !Array.isArray(router.stack)) continue;
    const name = file.split("/routes/quickbooks/")[1];
    for (const layer of router.stack || []) {
      if (!layer.route) continue;
      const path = layer.route.path.replace(/:[^/]+/g, SOME_UUID);
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path, router: name });
      }
    }
  }
  return out;
}

let server;
let base;

beforeAll(async () => {
  const app = require("../app.js");
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

describe("the gate claims every route its router defines", () => {
  // The property the prefix list could not hold. It is checked per router
  // rather than in aggregate so a failure names the file to look at.
  const { routerHandles } = require("./quickbooksAuth.js");

  it.each(quickbooksRouters())("%s", (file) => {
    const router = require(file);
    if (!router || !Array.isArray(router.stack)) return;
    const unclaimed = [];
    for (const layer of router.stack || []) {
      if (!layer.route) continue;
      const path = layer.route.path.replace(/:[^/]+/g, SOME_UUID);
      for (const method of Object.keys(layer.route.methods)) {
        if (!routerHandles(router, method, path)) unclaimed.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(unclaimed).toEqual([]);
  });
});

describe("every QuickBooks route requires authentication", () => {
  const routes = definedRoutes();

  it("finds routes to check", () => {
    // Guards the guard: if the enumeration silently returned nothing, every
    // case below would vacuously pass and this file would prove nothing.
    expect(routes.length).toBeGreaterThan(20);
  });

  it.each(routes)("$method $path ($router)", async ({ method, path }) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: ["GET", "HEAD"].includes(method) ? undefined : "{}",
    });

    // The body matters as much as the code: `requireAuth` answers exactly this,
    // whereas a handler that ran and disliked its input can also produce a 401.
    // Asserting the code alone would let a handler execute and still pass.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Missing token" });
  });

  it.each(routes.filter((r) => r.method === "GET").slice(0, 5))(
    "HEAD $path is gated too",
    async ({ path }) => {
      // Express dispatches HEAD to a GET handler when no HEAD route exists, so
      // a gate that matched on the verb alone would leave every GET route open
      // to anyone who spelled the request differently.
      const res = await fetch(`${base}${path}`, { method: "HEAD" });
      expect(res.status).toBe(401);
    },
  );
});

describe("requests that are not this router's business pass through", () => {
  const { routerHandles } = require("./quickbooksAuth.js");
  const customers = require("../routes/quickbooks/customers/customers.js");

  it("does not claim a path the router never defined", () => {
    // The routers sit at "/" and see every request in the app, including ones
    // bound for messages and folders further down the chain.
    expect(routerHandles(customers, "GET", "/messages")).toBe(false);
  });

  it("claims a route the old prefix list had forgotten", () => {
    // `bankVsBooks` serves `/manual-report-uploads/*`, a prefix `qbPaths` never
    // listed — so these reached their handlers with no company check at all.
    // (`PUT /api/customers/:id`, the original example, has since been deleted
    // as dead.)
    const bankVsBooks = require("../routes/quickbooks/reconciliation/bankVsBooks.js");
    expect(routerHandles(bankVsBooks, "GET", "/manual-report-uploads/bs-bank-balances")).toBe(true);
  });

  it("treats HEAD as GET, because Express does", () => {
    expect(routerHandles(customers, "HEAD", "/customers")).toBe(
      routerHandles(customers, "GET", "/customers"),
    );
  });

  it("ignores a method the route does not define", () => {
    expect(routerHandles(customers, "DELETE", "/customers")).toBe(false);
  });
});

describe("the OAuth handshake, which this gate does not cover", () => {
  it("leaves the Intuit redirect reachable without a session", async () => {
    // Mounted before the financial routers and outside the gate. A 401 here
    // means QuickBooks cannot be connected at all.
    const res = await fetch(`${base}/api/auth/callback`, { method: "GET" });
    expect(res.status).not.toBe(401);
  });

  it("still requires a credential to START the handshake", async () => {
    // `requireAuthAllowQueryToken`: a token may travel in the query string so a
    // browser redirect can carry it, but one is required.
    const res = await fetch(`${base}/api/auth/quickbooks`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});
