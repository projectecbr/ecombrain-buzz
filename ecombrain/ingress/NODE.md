# Teams ingress on Node

The same ingress as the Cloudflare worker (`src/handler.ts` makes every auth and routing decision), served by
`node:http` so Teams can run on a VPS behind a tunnel. `src/node-server.ts` turns each request into a WHATWG
Request, runs the handler, and carries the handler's rewritten request to a local upstream. WebSocket upgrades
(relay and `/teams/bunker`) are piped only after the handler admitted them. No dependencies; Node 22.18 or later.

Run: `npm start` (or `Dockerfile.node`). Test: `npm test`.

## Environment (names only; values live in the secret store)

| Name | Meaning |
|------|---------|
| TEAMS_INGRESS_SERVICE_SECRET | HMAC secret shared with the product's `/api/internal/teams/ingress/*` routes (32+ chars) |
| TEAMS_PRODUCT_API_URL | Product origin, https only |
| TEAMS_RELAY_SERVICE_SECRET | Master secret for signed relay service requests |
| TEAMS_OPERATOR_SERVICE_SECRET | Secret for signed operator requests |
| TEAMS_BUNKER_PUBKEY | Identity bridge bunker public key (64 hex) |
| TEAMS_PUBLIC_ORIGIN | The public origin the tunnel serves; only request paths are used |
| TEAMS_RELAY_UPSTREAM | Relay container origin, default `http://127.0.0.1:3001` |
| TEAMS_IDENTITY_BRIDGE_UPSTREAM | Identity bridge origin, default `http://127.0.0.1:3002` |
| PORT | Listen port, default 8787 |
| TEAMS_INGRESS_BIND | Listen address, default `127.0.0.1` (the Docker image sets `0.0.0.0`) |

The relay and identity bridge keep the env names listed in `src/index.ts` (`RelayContainer`,
`IdentityBridgeContainer`). Upstreams are plain HTTP and must only be reachable on loopback or a private network.

## Differences from the worker
- One relay and one identity bridge process, like the worker's singleton containers.
- Request bodies are capped at 100 MB (the Workers limit); a larger declared body gets 413.
- Absolute-form request targets get 400; only origin-form paths are routed.
