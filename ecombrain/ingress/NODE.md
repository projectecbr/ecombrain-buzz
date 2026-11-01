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
| TEAMS_RELAY_UPSTREAM | Relay origin, required (inside a container 127.0.0.1 is the ingress itself) |
| TEAMS_IDENTITY_BRIDGE_UPSTREAM | Identity bridge origin, required |
| PORT | Listen port, default 8787 |
| TEAMS_INGRESS_BIND | Listen address, default `127.0.0.1` (the Docker image sets `0.0.0.0`) |

The relay and identity bridge keep the env names listed in `src/index.ts` (`RelayContainer`,
`IdentityBridgeContainer`). Upstreams are plain HTTP and must only be reachable on loopback or a private network.

Publish only to the tunnel: `docker run -p 127.0.0.1:8787:8787 ...` or a Docker network shared with cloudflared.
A plain `-p 8787:8787` exposes the ingress on every host interface, around the tunnel.

Reach the relay over a Docker network, not host networking on 127.0.0.1: the relay trusts loopback peers on
`/internal/git/policy`, and every request the ingress forwards would arrive from loopback.

## Hardening (gate 66be6e1e)
- Upstream framing is never copied from the client: length or chunking is derived from the body actually sent,
  GET/HEAD send no body, and every upstream call uses its own connection, so nothing can be smuggled to the relay.
- Upgrades must be WebSocket and carry no body; anything else gets 400.
- Bodies: relay paths 100 MB (the Workers limit); signed service paths 1 MB. handler.ts checks the service signature
  over the declared body hash before it reads the body, so unsigned callers get 401 without holding anything; at most
  32 signed body reads run at once (503 beyond). Over the cap: 413.
- The client leaving cancels the upstream call; an upgrade the upstream doesn't answer in 10 s gets 504; idle upstream
  calls end after 60 s. Shutdown closes open WebSockets.
- Only origin-form targets are routed (absolute-form, `//` and backslashes get 400).
