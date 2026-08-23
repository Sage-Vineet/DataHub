import { createRequire } from "node:module";
import { createServer } from "node:http";
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

/** The financial routers, in the same order `app.js` mounts them. */
const ROUTERS = [
  "balancesheet/balanceSheet",
  "balancesheet/balanceSheetFullDetail",
  "account_detail/generalLedger",
  "profit_and_loss/profitAndLoss",
  "profit_and_loss/profitAndLossStatement",
  "customers/customers",
  "invoices/invoices",
  "cash_flow/cash_flow",
  "reconciliation/Reconciliation",
  "tax_reconciliation/Tax_Reconciliation",
  "tax_reconciliation/geminiPdf",
  "reconciliation/bankStatement",
  "reconciliation/bankVsBooks",
  "sync",
];

const SOME_UUID = "11111111-2222-3333-4444-555555555555";

/** Every (method, path) the financial routers define, params filled in. */
function definedRoutes() {
  const out = [];
  for (const name of ROUTERS) {
    const router = require(`../routes/quickbooks/${name}.js`);
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

  it.each(ROUTERS)("%s", (name) => {
    const router = require(`../routes/quickbooks/${name}.js`);
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
    expect(routes.length).toBeGreaterThan(30);
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

  it("claims the route the list had forgotten", () => {
    expect(routerHandles(customers, "PUT", `/api/customers/${SOME_UUID}`)).toBe(true);
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
