import {
  MACHINE_CLOSE,
  parseDaemonFrame,
  type MachineCoreFrame,
  type MachineDaemonFrame,
} from "../../../../apps/core/src/shared/machine-socket.ts";

export interface FakeCore {
  received: MachineDaemonFrame[];
  server: Bun.Server<undefined>;
  url: string;
}

export function startFakeCore(
  next: (frame: MachineDaemonFrame) => MachineCoreFrame | null,
): FakeCore {
  const received: MachineDaemonFrame[] = [];
  const server = Bun.serve<undefined>({
    port: 0,
    fetch: (request, bunServer): Response | undefined =>
      bunServer.upgrade(request)
        ? undefined
        : new Response("no", { status: 400 }),
    websocket: {
      message: function (socket, raw): void {
        const frame = parseDaemonFrame(raw);
        if (!frame) {
          socket.close(
            MACHINE_CLOSE.badFrame.code,
            MACHINE_CLOSE.badFrame.reason,
          );

          return;
        }
        received.push(frame);
        if (frame.type === "hello") {
          socket.send(JSON.stringify({ type: "ready", sandboxId: "sbx_1" }));
        }
        const reply = next(frame);
        if (reply) {
          socket.send(JSON.stringify(reply));
        } else {
          // A replaced close stops the daemon under test instead of reconnecting.
          socket.close(
            MACHINE_CLOSE.replaced.code,
            MACHINE_CLOSE.replaced.reason,
          );
        }
      },
    },
  });

  return {
    received: received,
    server: server,
    url: `http://127.0.0.1:${server.port}`,
  };
}
