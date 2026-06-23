# broods

CLI and TypeScript SDK for the Broods agent platform.

## Install

```bash
bun add broods
# or
npm install broods
```

The CLI requires Bun:

```bash
bun add -g broods
broods dev
```

## Invoke an Agent

```ts
import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient({
  apiKey: process.env.BROODS_API_KEY,
});

const result = await client.run(api.agents.myAgent, {
  input: "Hello",
});

console.log(result.text);
```

Runtime calls use an environment runtime API key. After `broods deploy`, the CLI
writes `BROODS_API_KEY` to `.env.local`; the SDK also accepts `apiKey`,
`BROODS_API_KEY`, `baseUrl`, and `BROODS_BASE_URL`.

## License

The `broods` npm package, including the CLI and TypeScript client SDK, is MIT
licensed. The core server code in the monorepo is licensed separately.

Documentation: https://github.com/beeblastco/broods/tree/dev/apps/docs/docs
