# Connections

A connection is an external account your agents act through: your ChatGPT plan, a Gmail inbox, an Outlook mailbox. You sign in once, in the browser, and Broods keeps the account's token fresh from then on. Every agent in the account can use it.

```bash
broods connect chatgpt      # sign in with ChatGPT
broods connect google       # sign in with Google (Gmail)
broods connect microsoft    # sign in with Microsoft (Outlook)
broods connect              # list connections
broods disconnect google    # forget and revoke
```

| Type        | For                                               |
| ----------- | ------------------------------------------------- |
| `chatgpt`   | `model.provider: "chatgpt"`, on your ChatGPT plan |
| `google`    | Gmail MCP servers                                 |
| `microsoft` | Outlook mail MCP servers                          |

There is nothing to pass: `broods connect` opens the provider's sign-in, you approve, and the connection is kept on your deployment. It uses your `broods login`, or `BROODS_ACCOUNT_SECRET` when that is set. The dashboard lists the account's connections under **Connections**, where an org admin can disconnect one.

## ChatGPT plan

`broods connect chatgpt` signs in with ChatGPT. Agents on the `chatgpt` model provider use it, with no `provider.chatgpt` entry:

```ts
model: { provider: "chatgpt", modelId: "gpt-5.5" },
```

The CLI prints the model ids your plan can use. The provider's limits are in [Agents](agents.md#chatgpt-plan).

## Gmail, Outlook and other MCP servers

Name the connection type on the agent's MCP entry. Broods sends its access token as the `Authorization` header and refreshes it before it expires, so the server needs no `oauth` of its own:

```ts
export const gmail = defineMcp({
  name: "gmail",
  url: "https://gmailmcp.googleapis.com/mcp/v1",
});

export const assistant = defineAgent({
  name: "assistant",
  mcp: {
    [gmail.name]: { enabled: true, oauth: { connection: "google" } },
  },
});
```

A ChatGPT plan token is only for the model provider; `oauth.connection` takes `google` or `microsoft`.

## How it works

- `broods connect` keeps the PKCE verifier and listens on `http://127.0.0.1:1455/auth/callback`, or another free port when 1455 is busy. Your deployment builds the consent screen, trades the code the browser brings back, and checks the ID token's signature, issuer, audience, expiry and nonce before anything is kept.
- Tokens are encrypted at rest and never returned by the API, the CLI or the dashboard.
- Signing in again replaces the connection. A ChatGPT reconnect keeps its OAuth client and host id.
- `broods disconnect` forgets the connection, then revokes the refresh token at the provider. Microsoft has no revocation endpoint; end the grant in your Microsoft account settings.
- If `broods connect google` or `microsoft` answers that the deployment has no OAuth app yet, whoever runs your deployment sets it up once. See [Self-hosting](../internals/self-hosting.md).
