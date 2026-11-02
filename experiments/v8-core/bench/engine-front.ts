/**
 * The front of several workerd engines, for benchmarks only: a request whose
 * JSON body names an `agentId` (a run) goes to the engine that agent hashes
 * to, so each agent's warm worker lives in one engine; anything else goes
 * round-robin. It stands in for a load balancer with a sticky hash (nginx
 * `hash`, Cloudflare's consistent-hash ring); it listens on loopback only.
 * FRONT_PLACE=least instead places each new agent on the engine with the
 * fewest agents and keeps it there (a placement table, as a scheduler keeps).
 * Usage: bun bench/engine-front.ts <port> <engine-port>...
 */

const [port, ...enginePorts] = process.argv.slice(2).map(Number);
if (!port || enginePorts.length === 0)
  throw new Error("usage: engine-front.ts <port> <engine-port>...");
let next = 0;
const least = process.env.FRONT_PLACE === "least";
const placed = new Map<string, number>();
const agentsOn = enginePorts.map((): number => 0);

/** FNV-1a: a stable 32-bit hash of the agent id. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  return h >>> 0;
}

function engineFor(agent: string): number {
  if (!least) return hash(agent) % enginePorts.length;
  let engine = placed.get(agent);
  if (engine === undefined) {
    engine = agentsOn.indexOf(Math.min(...agentsOn));
    placed.set(agent, engine);
    agentsOn[engine] += 1;
  }

  return engine;
}

function agentOf(body: ArrayBuffer): string | undefined {
  try {
    const id = JSON.parse(new TextDecoder().decode(body))?.agentId;

    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

Bun.serve({
  port: port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch: async (request: Request): Promise<Response> => {
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    const agent = body ? agentOf(body) : undefined;
    const engine =
      agent === undefined ? next++ % enginePorts.length : engineFor(agent);
    const url = new URL(request.url);
    url.host = `127.0.0.1:${enginePorts[engine]}`;

    return fetch(url, {
      method: request.method,
      headers: request.headers,
      body: body,
      redirect: "manual",
      decompress: false,
    });
  },
});
console.log(
  `engine front on ${port} -> ${enginePorts.join(", ")} (${least ? "fewest agents" : "hash"})`,
);
