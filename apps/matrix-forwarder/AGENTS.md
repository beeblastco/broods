# apps/matrix-forwarder

Holds the Matrix `/sync` long-polls nobody else does. `src/main.ts` is the only entry (`bun src/main.ts`). paths relative to `apps/matrix-forwarder/`.

Matrix delivers nothing over a webhook: a client long-polls `/sync` for its account's events. So this process is Matrix's `apps/discord-forwarder`. It subscribes to every config plane's `matrix` connections, runs one sync loop per access token, decrypts what arrives, and POSTs each `m.room.message` to that token's channel webhooks in the shape `apps/core/src/shared/matrix-wire.ts` defines:

```text
POST {plane webhookBaseUrl}{webhookPath}
x-matrix-access-token: <access token>

{ "type": "MATRIX_ROOM_EVENT", "encrypted": true, "event": { ... }, "roomId": "...", "senderName": "...", "userId": "..." }
```

Core sends back through `POST /v1/send` and `POST /v1/typing` here, authenticated with the same header, because this process holds the device keys an encrypted room needs.

## Gotchas

- **single replica, `strategy: Recreate`, never scale it.** each account's OlmMachine owns a SQLite crypto store, and a store must never have two writers: two pods on one volume corrupt it, and two sync loops on one token also deliver every message twice. `src/account.ts` also serializes the store inside the process, for a re-pointed account starting before the old one finished closing.
- **the store must be on a persistent volume.** `MATRIX_STORE_DIR` holds `<sha256 of user_id|device_id>/crypto/` and `sync-token`. lose it and the device's keys go with it: the device can no longer read encrypted rooms, and the account has to log in again as a new device. the env var is required on purpose, so a missing volume fails at startup instead of writing to ephemeral disk.
- **one process for every config plane, not one per stage.** same reason as Discord: the same account deployed to dev and prod must be one sync loop fanning out to both webhooks. it reuses `apps/discord-forwarder`'s `configPlanesEnv`, `watchChannelConnections`, backoff and log helpers by relative path.
- **it forwards everything and filters nothing.** not rooms, senders, edits or the account's own messages. the account is usually a person's, so which message is a trigger is core's decision.
- **the first sync skips backlog.** with no stored sync token the first `/sync` uses timeout 0 and forwards nothing, so a fresh store does not replay room history into the agent. an undecryptable event waits up to 5 minutes for its room key, then is dropped with a log line.
- **a timeline gap is logged, not backfilled.** `/sync` sets `limited` when a room took more than 50 messages since the last poll, and the events it left out are gone as soon as the new sync token is stored. recovering them needs `/messages` pagination and dedup state; the gap only appears after downtime or a burst, so the log line names the room and the agent sees the hole as missing context.
- **`M_UNKNOWN_TOKEN` stops that account, never the process.** other accounts keep running; a new token from the config plane starts a new account.
- **native module.** `@matrix-org/matrix-sdk-crypto-nodejs` downloads a prebuilt `.node` in its postinstall. CI and the Dockerfile install with `--ignore-scripts`, so the Dockerfile runs `download-lib.js` itself and the image runs a JS bundle with that package external (`--compile` cannot load it). only `src/crypto.ts` imports it at runtime; everything else takes it as a type so the tests run without the binary. locally, `bun install` runs the postinstall because the root `trustedDependencies` lists it.
- **it imports two core modules by relative path**, not as a package: `../../core/src/shared/matrix-wire.ts` (the wire contract) and `../../core/src/shared/env.ts`. `matrix-wire.ts` has no imports on purpose; core's adapter in `matrix-channel.ts` imports it, never the other way round, or the whole core channel stack lands in this bundle. rename either file and this build breaks: the Dockerfile and `build-matrix-forwarder.yaml` name them.
