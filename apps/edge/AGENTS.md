# apps/edge

The public route table and the Traefik config generated from it. Traefik is the front door everywhere: it routes each request to core, the Convex config plane or the gateway (WebSockets only), limits per client address, sets CORS, and writes the access log. Nothing here runs as a service. paths relative to `apps/edge/`.

## Gotchas

- `src/routes.ts` is the split: `ROUTERS`, in priority order, each one Traefik router. the config rules are **method-aware** (`/v1/account` is config only for GET/PATCH), and a method miss falls through to core. add a route in core or the config plane and add it here, or it lands on the wrong upstream. `verification/Broods/Gateway.lean` models this table; change one, change the other.
- **every router keeps the `headers` middleware first.** it stamps `x-broods-via-gateway`, which makes core and the config plane refuse the in-cluster service token, and it strips `X-Account-Id`. in-cluster-only core paths (`/v1/cron-runs`, `/v1/mcp-service/rpc`) are not routed specially: core refuses them without the service token.
- **Traefik keeps a rate-limit bucket per router and per pod.** a new router is a new bucket, so add rules to an existing router when the upstream, limit and logging match. keep Traefik at one replica or every limit multiplies.
- only the cluster config limits per client address, and only with `generate kubernetes --limits`: turn it on once PROXY protocol keeps the client address at the load balancer, or every client shares one bucket. the file config for the local stack and self-hosting has no limits.
- a path that is itself a credential (download links, media links) gets `secretPath`, which keeps its router out of the access log.
- `src/origins.ts` is the browser origin list both the edge's CORS and the gateway's WebSocket origin check default to; the gateway Dockerfile copies it.
- the cluster file lives in `../infra` (`kubernetes/namespaces/beeblast/broods-edge.yaml`). regenerate it with `bun run generate kubernetes [--limits] > <that file>` and land it through an infra PR. stage hosts and service names are in `src/generate.ts` and must match `../infra/kubernetes/charts/releases`. the config plane is in another namespace, so Traefik needs `providers.kubernetesCRD.allowCrossNamespace`.
- no body-size middleware: Traefik's `buffering` also buffers responses, which breaks SSE. core and Convex cap bodies themselves.
