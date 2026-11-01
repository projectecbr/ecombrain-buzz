/** Starts the Teams ingress on Node (VPS behind a tunnel). Same secrets as the worker; see NODE.md. */
import { createNodeIngress } from "./node-server.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const server = createNodeIngress({
  env: {
    TEAMS_INGRESS_SERVICE_SECRET: required("TEAMS_INGRESS_SERVICE_SECRET"),
    TEAMS_PRODUCT_API_URL: required("TEAMS_PRODUCT_API_URL"),
    TEAMS_RELAY_SERVICE_SECRET: required("TEAMS_RELAY_SERVICE_SECRET"),
    TEAMS_OPERATOR_SERVICE_SECRET: required("TEAMS_OPERATOR_SERVICE_SECRET"),
    TEAMS_BUNKER_PUBKEY: required("TEAMS_BUNKER_PUBKEY"),
  },
  relayUpstream: process.env.TEAMS_RELAY_UPSTREAM?.trim() || "http://127.0.0.1:3001",
  identityBridgeUpstream: process.env.TEAMS_IDENTITY_BRIDGE_UPSTREAM?.trim() || "http://127.0.0.1:3002",
  publicOrigin: required("TEAMS_PUBLIC_ORIGIN"),
});

const port = Number(process.env.PORT ?? 8787);
// Loopback by default: the tunnel connects locally, nothing else should reach the ingress directly.
server.listen(port, process.env.TEAMS_INGRESS_BIND?.trim() || "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.close(() => process.exit(0)));
