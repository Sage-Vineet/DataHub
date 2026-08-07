import { createGateway } from "./gateway.js";
import { parseRoutingTable } from "./routing.js";

function main(): void {
  // Fail closed on malformed/missing routing config (never start with undefined routing).
  const table = parseRoutingTable(process.env);
  const app = createGateway(table);
  const port = Number(process.env.PORT ?? 8080);

  app.listen(port, () => {
    const routes =
      table.routes.length > 0
        ? table.routes.map((r) => `${r.prefix} -> ${r.origin}`).join(", ")
        : "(none)";
    console.warn(
      `[gateway] listening on :${port} | default -> legacy (${table.origins.legacy}) | routes: ${routes}`,
    );
  });
}

main();
