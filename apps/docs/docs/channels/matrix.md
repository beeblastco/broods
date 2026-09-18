# Matrix

A Matrix account is how the agent reaches Matrix rooms. Matrix has no webhooks, so the `apps/matrix-forwarder` deployment long-polls `/sync` for each account, decrypts what arrives, and posts every room message to the channel webhook. It also holds the account's end-to-end encryption keys, so replies and reactions go back out through it.

Matrix has no bot accounts. The account is usually a person's own, and the agent speaks as that person. Each reply carries a per-message profile named `botName`, so the room sees who is talking, and Broods marks its own events so it never answers itself or mistakes its owner's messages for its replies.

## Configuration

Define a Matrix connection with `defineMatrixConnection`, name the rooms it answers in with `defineMatrixChannel`, and attach the connection to an agent:

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

- `apiUrl`: homeserver base URL, e.g. `https://matrix.org`. It must be public `https`: core and the forwarder call it with the account's token.
- `botToken`: access token of the account. See [Access token](#access-token).
- `botName` (optional): name replies are shown under. Unset, replies look like the account's own messages.
- `mentionText` (optional, recommended): text that addresses the agent, e.g. `@georgi-ai`. Unset, a mention of the account does, which on a personal account also means every mention of its owner.
- `allowedChannelIds` (optional): `["*"]` to answer in every joined room instead of only the declared ones.
- `allowedUserIds` (optional): Matrix user ids allowed to trigger the agent, e.g. `@alice:matrix.org`. Everyone, when omitted.

Declaring a `botToken` is what enrolls the account with the forwarder. Nothing else to configure per agent.

## Being addressed

The agent runs only for messages that address it. Every other message in an allowed room is stored as context, so a later mention still sees what the room said. `/new`, `/clear`, `/compact`, and `/help` work as in other chat channels.

A message in a thread keeps its conversation to that thread, and the reply lands in the same thread.

## Access token

Log in once as a dedicated device for Broods. Do not reuse the token of Element or another client: encryption keys belong to a device, and the forwarder needs its own.

```bash
curl -s https://matrix.org/_matrix/client/v3/login \
  -H 'content-type: application/json' \
  -d '{
    "type": "m.login.password",
    "identifier": { "type": "m.id.user", "user": "georgi" },
    "password": "…",
    "initial_device_display_name": "Broods"
  }'
```

A homeserver that only offers single sign-on has no password login. Open `/_matrix/client/v3/login/sso/redirect?redirectUrl=<a local URL you serve>`, sign in, and trade the `loginToken` it redirects back with for an access token by posting `{"type": "m.login.token", "token": "…", "initial_device_display_name": "Broods"}` to the same `/login` endpoint.

Store the `access_token` from the response with `broods env set MATRIX_ACCESS_TOKEN`. Logging that device out from another client revokes the token.

## Encrypted rooms

Encrypted rooms work. The forwarder decrypts inbound messages and encrypts replies and uploaded files. A new device only receives keys for messages sent after it was created, so the agent cannot read a room's earlier encrypted history.
