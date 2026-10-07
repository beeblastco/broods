# Connections

A connection is an external account your agents act through. You sign in once, in the browser, and Broods keeps the account's token fresh from then on. Every agent in the account can use it.

Today the only type is `chatgpt`, your ChatGPT plan. Gmail and Outlook are [planned](https://github.com/beeblastco/broods/issues/913).

```bash
broods connect chatgpt      # sign in with ChatGPT
broods connect              # list connections
broods disconnect chatgpt   # forget and revoke
```

There is nothing to pass: `broods connect` opens the provider's sign-in, you approve, and the connection is kept on your deployment. It uses your `broods login`, or `BROODS_ACCOUNT_SECRET` when that is set. The dashboard lists every connection type under **Connections**, with the account each one is signed in as, and an org admin can disconnect one there.

## ChatGPT plan

`broods connect chatgpt` signs in with ChatGPT. Agents on the `chatgpt` model provider use it, with no `provider.chatgpt` entry:

```ts
model: { provider: "chatgpt", modelId: "gpt-5.5" },
```

The CLI prints the model ids your plan can use. The provider's limits are in [Agents](agents.md#chatgpt-plan).

## How it works

- `broods connect` keeps the PKCE verifier and listens on `http://127.0.0.1:1455/auth/callback`, or another free port when 1455 is busy. Your deployment builds the consent screen, trades the code the browser brings back, and checks the ID token's signature, issuer, audience, expiry and nonce before anything is kept.
- Tokens are encrypted at rest and never returned by the API, the CLI or the dashboard.
- Signing in again replaces the connection and keeps its OAuth client and host id.
- `broods disconnect` forgets the connection, then revokes the refresh token at the provider.
