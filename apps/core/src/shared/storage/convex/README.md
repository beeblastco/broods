# Convex storage adapter

The core uses Convex for every configuration and runtime persistence domain.

- `index.ts` implements the domain-shaped `StorageProvider`.
- `client.ts` creates the deploy-key-authenticated `ConvexHttpClient`.
- `runtime.ts` exposes the transactional runtime function boundary.
- sandbox and usage helpers keep their focused Convex calls beside the adapter.

Every stage requires `CONVEX_URL` and `CONVEX_DEPLOY_KEY`.
