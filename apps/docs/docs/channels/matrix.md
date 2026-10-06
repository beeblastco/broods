---
title: Matrix
---

# Matrix

A Matrix account puts your agent in Matrix rooms, including end-to-end encrypted ones.

Matrix has no webhooks and no bot accounts. The hosted Matrix forwarder long-polls the homeserver for your account, decrypts what arrives and posts each room message to your webhook. It also holds the account's encryption keys, so replies go back out through it.

The account is often a person's own, and the agent speaks as that person. Each reply carries a per-message display name, `botName`, so the room can tell who is talking. Broods marks its own events, so it never answers itself or mistakes its owner's messages for its replies.

## Setup

1. Log in as a new device dedicated to Broods and copy the access token. See [Access token](#access-token).
2. Store it:

   ```bash
   broods env set MATRIX_ACCESS_TOKEN
   ```

3. Define the connection and the rooms it answers in:

   ```ts title="broods/index.ts"
   import {
     defineAgent,
     defineMatrixChannel,
     defineMatrixConnection,
     env,
   } from "broods";

   export const matrix = defineMatrixConnection({
     apiUrl: "https://matrix.org",
     botToken: env("MATRIX_ACCESS_TOKEN"),
     botName: "Georgi AI",
     mentionText: "@georgi-ai",
   });

   export const team = defineMatrixChannel({
     name: "team",
     connection: matrix,
     channelId: "!abc123:matrix.org",
   });

   export const myAgent = defineAgent({
     name: "my-agent",
     connections: [matrix],
   });
   ```

4. Run `broods dev` or `broods deploy`. There is no webhook to register. Declaring `botToken` enrolls the account with the forwarder.

## Configuration

| Field               | Required | Description                                                                       |
| ------------------- | -------- | --------------------------------------------------------------------------------- |
| `apiUrl`            | yes      | homeserver base URL, such as `https://matrix.org`. Must be public `https`         |
| `botToken`          | yes      | access token of the account                                                       |
| `botName`           | no       | name replies are shown under. Unset, replies look like the account's own messages |
| `mentionText`       | no       | text that addresses the agent, such as `@georgi-ai`                               |
| `allowedChannelIds` | no       | extra room ids, or `["*"]` for every joined room                                  |
| `allowedUserIds`    | no       | Matrix user ids such as `@alice:matrix.org`. Everyone when omitted                |
| `trace`             | no       | `"enabled"` adds the dashboard trace link to replies                              |
| `partition`         | no       | workspace folder split. See [Workspaces](../guides/workspaces.md)                 |

## When the agent answers

The agent runs only for messages that address it. With `mentionText` set, that text does. Without it, a mention of the account does, which on a personal account also means every mention of its owner. Set `mentionText` for personal accounts.

Other messages in an allowed room are stored as context. `/new`, `/clear`, `/compact` and `/help` work as in other chat channels. A message in a thread keeps its own conversation, and the reply lands in the same thread.

## Access token

Log in once as a dedicated device. Do not reuse the token of Element or another client, because encryption keys belong to a device and the forwarder needs its own.

```bash
curl -s https://matrix.org/_matrix/client/v3/login \
  -H 'content-type: application/json' \
  -d '{
    "type": "m.login.password",
    "identifier": { "type": "m.id.user", "user": "georgi" },
    "password": "...",
    "initial_device_display_name": "Broods"
  }'
```

Store `access_token` from the response with `broods env set MATRIX_ACCESS_TOKEN`.

A homeserver with only single sign-on has no password login:

1. Open `/_matrix/client/v3/login/sso/redirect?redirectUrl=<a local URL you serve>` and sign in.
2. Take the `loginToken` from the redirect.
3. POST `{"type": "m.login.token", "token": "...", "initial_device_display_name": "Broods"}` to the same `/login` endpoint.

Logging that device out from another client revokes the token.

## Encrypted rooms

Encrypted rooms work. The forwarder decrypts inbound messages and encrypts replies and uploaded files. A new device only receives keys for messages sent after it was created, so the agent cannot read a room's earlier encrypted history.

See [Channels](index.md) for commands, channel tools and attachment limits.
