# Networking

`config.network` controls outbound egress from the sandbox. It replaces the old
Lambda-only `internet` boolean. If omitted, the config normalizes to `deny-all`.

```jsonc
{
  "config": {
    "provider": "sandbox",
    "network": {
      "mode": "restricted",
      "allowDomains": ["api.example.com"],
      "allowCidrs": ["10.0.0.0/8"]
    }
  }
}
```

| Mode | Meaning |
| --- | --- |
| `allow-all` | outbound internet allowed |
| `deny-all` | outbound internet denied |
| `restricted` | allow only listed domains/CIDRs where the provider can enforce them |

## Provider enforcement

Enforcement is best-effort and provider-specific. Where a provider cannot enforce a
finer-grained rule, the harness logs a warning rather than silently pretending it applied.

| Provider | `allow-all` | `deny-all` | `restricted` |
| --- | --- | --- | --- |
| `sandbox` | egress allowed | egress denied | domain + CIDR allowlist (workdir egress policy) |
| `lambda` | default `INTERNET_EGRESS` | VPC egress connector (no internet) | VPC egress connector + SG (domain allowlists logged as unsupported); fails closed if no connector is provisioned |
| `vercel` | native `networkPolicy: "allow-all"` | native `networkPolicy: "deny-all"` | native domain + CIDR allowlists |
| `daytona` | `networkBlockAll: false` | `networkBlockAll: true` | CIDR allowlist only; domain allowlists are ignored with a warning |
| `e2b` | allowed | rejected by validation | rejected by validation |

E2B cannot enforce egress restrictions, so its config validation requires
`network.mode: "allow-all"` explicitly — `deny-all` and `restricted` are rejected rather
than accepted-but-ignored.

## Egress and background-job auto-delivery

Detached background jobs POST their result back to the harness Function URL when they
finish (see [Best practice → Background jobs](best-practice.md#background-jobs--async_status)).
That push-back needs outbound egress:

> Auto-delivery requires the sandbox to reach the harness Function URL. Set
> `network.mode: "allow-all"` or include the Function URL in a provider-supported
> allowlist. Without egress the job still runs and `async_status` polling still works —
> only the automatic push-back is skipped.

WebSocket delivery additionally requires the cluster's NATS to expose a WebSocket
listener/gateway (infra repo, applied via CI/CD); the durable stream persists regardless,
so a client replays on reconnect. See
[Architecture → WebSocket Gateway](../../architecture.md).
