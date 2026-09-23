import { afterEach, expect, test } from "bun:test";
import type { MachineComputerFrame } from "../../../apps/core/src/shared/machine-socket.ts";
import { startDesktop, type DesktopDriver } from "../src/cli/desktop.ts";
import { runMachineDaemon } from "../src/cli/machine.ts";
import { startFakeCore } from "./fixtures/fake-core.ts";

// These drive this Mac through the real Swift helper, so they skip elsewhere.
const macOnly = test.skipIf(process.platform !== "darwin");
const drivers: DesktopDriver[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.stop();
  for (const server of servers.splice(0)) server.stop(true);
});

macOnly(
  "the helper screenshots at the reported frame and maps the cursor both ways",
  async () => {
    const { display, driver } = await startDesktop(false);
    drivers.push(driver);

    expect(Math.max(display.width, display.height)).toBeLessThanOrEqual(1280);

    const shot = await driver.run(computer("screenshot"));
    expect(shot.error).toBeUndefined();
    expect(pngSize(shot.image?.data ?? "")).toEqual({
      width: display.width,
      height: display.height,
    });

    const before = await driver.run(computer("cursor_position"));
    const x = Math.round(display.width / 3);
    const y = Math.round(display.height / 3);
    await driver.run(computer("mouse_move", { coordinate: [x, y] }));
    const after = await driver.run(computer("cursor_position"));
    expect(after.text).toBe(`X=${x},Y=${y}`);
    // Put the cursor back where the person left it.
    const restore = /X=(\d+),Y=(\d+)/.exec(before.text ?? "");
    if (restore) {
      await driver.run(
        computer("mouse_move", {
          coordinate: [Number(restore[1]), Number(restore[2])],
        }),
      );
    }

    const outside = await driver.run(
      computer("left_click", { coordinate: [display.width + 50, 0] }),
    );
    expect(outside.error).toContain("outside");
  },
);

macOnly(
  "a daemon started with --computer says so in hello and answers a computer frame",
  async () => {
    const core = startFakeCore((frame) =>
      frame.type === "hello" ? computer("cursor_position") : null,
    );
    servers.push(core.server);

    await expect(
      runMachineDaemon({
        credential: async (): Promise<string> => "key",
        baseUrl: core.url,
        computer: true,
        cwd: process.cwd(),
        log: () => {},
        sandbox: "my-mac",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Replaced by a newer connection");

    expect(core.received[0]).toMatchObject({ type: "hello", computer: true });
    expect(core.received[1]).toMatchObject({
      type: "computer-result",
      text: expect.stringMatching(/^X=\d+,Y=\d+$/),
    });
  },
);

function computer(
  action: MachineComputerFrame["action"],
  fields: Partial<MachineComputerFrame> = {},
): MachineComputerFrame {
  return {
    type: "computer",
    id: crypto.randomUUID(),
    action: action,
    ...fields,
  };
}

// Width and height from a PNG header.
function pngSize(data: string): { width: number; height: number } {
  const bytes = Buffer.from(data, "base64");

  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
