# Connections

A connection is an external account your agents act through: your ChatGPT plan, a Gmail inbox, an Outlook mailbox. You sign it in once, from the machine with your browser, and Broods keeps its token fresh from then on. Every agent in the account can use it.

```bash
broods connect chatgpt                    # run agents on your ChatGPT plan
broods connect google --name gmail \
  --client-id 1234.apps.googleusercontent.com --client-secret "$GOOGLE_SECRET"
broods connect                            # list connections
broods disconnect gmail                   # forget and revoke
```

| Type        | For                                               | OAuth app                    |
| ----------- | ------------------------------------------------- | ---------------------------- |
| `chatgpt`   | `model.provider: "chatgpt"`, on your ChatGPT plan | Registered by Broods for you |
| `google`    | Gmail, Calendar, Drive MCP servers                | Yours: client id and secret  |
| `microsoft` | Outlook mail and calendar MCP servers             | Yours: client id             |

`broods connect` uses `BROODS_ACCOUNT_SECRET` when it is set, otherwise your `broods login`. The dashboard lists the account's connections under **Connections**, where an org admin can disconnect one.

## ChatGPT plan

`broods connect chatgpt` signs in with ChatGPT and stores the connection as `chatgpt`. Agents on the `chatgpt` model provider use it, with no `provider.chatgpt` entry:

```ts
model: { provider: "chatgpt", modelId: "gpt-5.5" },
```

The CLI prints the model ids your plan can use. The provider's limits are in [Agents](agents.md#chatgpt-plan).

## Gmail, Outlook and other MCP servers

Name the connection on the agent's MCP entry. Broods sends its access token as the `Authorization` header and refreshes it before it expires, so the server needs no `oauth` of its own:

```ts
export const gmail = defineMcp({
  name: "gmail",
  url: "https://gmailmcp.googleapis.com/mcp/v1",
});

export const assistant = defineAgent({
  name: "assistant",
  mcp: {
    [gmail.name]: { enabled: true, oauth: { connection: "gmail" } },
  },
});
```

`google` and `microsoft` run on your own OAuth app, since Broods does not ship one:

- **Google**: create a **Desktop app** OAuth client in Google Cloud and enable the APIs you need. Desktop clients accept the loopback redirect `broods connect` listens on.
- **Microsoft**: register an app in Microsoft Entra with a **Mobile and desktop** redirect URI of `http://127.0.0.1/auth/callback`. Entra ignores the loopback port, and no secret is needed.

The default scopes are identity plus mail (`gmail.modify`, `Mail.ReadWrite`). Pass `--scope` to ask for others, space or comma separated, for example `--scope "openid email https://www.googleapis.com/auth/calendar"`.

## How it works

- The browser redirect comes back to `http://127.0.0.1:1455/auth/callback`, or another free port when 1455 is busy. The CLI checks the ID token's signature, issuer, audience, expiry and nonce before anything is stored.
- Tokens and your client secret are encrypted at rest and never returned by the API or the dashboard.
- Signing in again under the same name replaces the connection. A ChatGPT reconnect keeps its OAuth client and host id; an own-app reconnect reuses the client id.
- `broods disconnect` forgets the connection, then revokes the refresh token at the provider. Microsoft has no revocation endpoint; end the grant in your Microsoft account settings.

| Option             | Meaning                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`    | Connection name, default the type. Lowercase letters, digits and dashes. A `chatgpt` connection is always `chatgpt`. |
| `--scope <scopes>` | Scopes to request instead of the type's defaults.                                                                    |
| `--client-id`      | Your OAuth app's client id (`google`, `microsoft`).                                                                  |
| `--client-secret`  | Your OAuth app's client secret (`google`).                                                                           |
