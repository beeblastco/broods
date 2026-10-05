# apps/edge

The public route table and the Traefik config generated from it. Traefik is the front door everywhere: it routes each request to core, the Convex config plane or the gateway (WebSockets only), limits per client address, sets CORS, and writes the access log. Nothing here runs as a service. paths relative to `apps/edge/`.

## Gotchas

- `src/routes.ts` is the split. order is priority, the config rules are **method-aware** (`/v1/account` is config only for GET/PATCH), and a method miss falls through to core. add a route in core or the config plane and add it here, or it lands on the wrong upstream. `verification/Broods/Gateway.lean` models this table; change one, change the other.
- **every public route must keep the `headers` middleware first.** it stamps `x-broods-via-gateway`, which makes core and the config plane refuse the in-cluster service token, and it strips `X-Account-Id`. a route without it lets the service token in from outside.
- the cluster file lives in `../infra` (`kubernetes/namespaces/beeblast/broods-edge.yaml`). regenerate it with `bun run generate kubernetes > <that file>` and land it through an infra PR. stage hosts and service names are in `src/generate.ts` and must match `../infra/kubernetes/charts/releases`.
- the config plane is in another namespace, so Traefik needs `providers.kubernetesCRD.allowCrossNamespace`.
- only the cluster config limits per client address, and only with `generate kubernetes --limits`: turn it on once PROXY protocol keeps the client address at the load balancer, or every client shares one bucket. the file config for the local stack and self-hosting has no limits.
- **Traefik keeps a rate-limit bucket per router and per pod.** routes sharing an upstream, limit and logging render as one router (`routerGroups`) so a client gets one bucket per plane, not one per route. a new route with a new combination adds a bucket. keep Traefik at one replica or every limit multiplies.
- no body-size middleware: Traefik's `buffering` also buffers responses, which breaks SSE. core and Convex cap bodies themselves.
