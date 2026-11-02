import { expect, test, type Page } from "@playwright/test";
import { openGallery } from "../lib/gallery";

const PANEL = '[data-slot="side-panel"]';
const WIDTH = 1280;

test.use({ viewport: { width: WIDTH, height: 800 } });

interface PanelFrame {
  canvasWidth: number;
  closing: boolean;
  hidden: boolean;
  inputTakesPointer: boolean;
  inputFocused: boolean;
  opacity: number;
  pointerReachesCanvas: boolean;
  running: number;
  title: string;
}

// Reads the panel in the commit after the press, before a frame of its transition passes.
async function pressAndRead(page: Page, button: string): Promise<PanelFrame> {
  return page.evaluate(
    async ([selector, panelSelector]) => {
      document.querySelector<HTMLButtonElement>(selector)?.click();
      await Promise.resolve();
      const panel = document.querySelector<HTMLElement>(panelSelector);
      const canvas = document.querySelector("[data-canvas]");
      if (!panel || !canvas) throw new Error("The motion fixture is missing.");
      const input = panel.querySelector("input");
      const inputBox = input?.getBoundingClientRect();
      input?.focus();
      const panelBox = panel.getBoundingClientRect();
      const under = document.elementFromPoint(
        panelBox.x + panelBox.width / 2,
        panelBox.y + panelBox.height / 2,
      );

      return {
        canvasWidth: canvas.getBoundingClientRect().width,
        closing: panel.hasAttribute("data-closing"),
        hidden: panel.hidden === true,
        inputTakesPointer:
          inputBox !== undefined &&
          document.elementFromPoint(
            inputBox.x + inputBox.width / 2,
            inputBox.y + inputBox.height / 2,
          ) === input,
        inputFocused: input !== null && document.activeElement === input,
        opacity: Number(getComputedStyle(panel).opacity),
        pointerReachesCanvas: under !== null && canvas.contains(under),
        running: panel.getAnimations().length,
        title: panel.querySelector("h2")?.textContent ?? "",
      };
    },
    [button, PANEL],
  );
}

async function settled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        (selector) =>
          document.querySelector(selector)?.getAnimations().length ?? 0,
        PANEL,
      ),
    )
    .toBe(0);
}

test.describe("canvas side panel", () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page, "motion");
  });

  test("opens at full width in one step, its content fading in, usable at once", async ({
    page,
  }) => {
    const open = await pressAndRead(page, '[data-open="support"]');
    expect(open.hidden).toBe(false);
    expect(open.canvasWidth).toBeCloseTo(WIDTH * 0.6, 0);
    expect(open.running).toBeGreaterThan(0);
    expect(open.opacity).toBeLessThan(0.9);
    expect(open.inputTakesPointer).toBe(true);
    expect(open.inputFocused).toBe(true);
    await page.keyboard.type("hello");
    await expect(page.getByLabel("Message")).toHaveValue("hello");
    await settled(page);
    await expect(page.locator(PANEL)).toHaveCSS("opacity", "1");
  });

  test("switching nodes swaps the content without replaying the enter", async ({
    page,
  }) => {
    await pressAndRead(page, '[data-open="support"]');
    await settled(page);
    const switched = await pressAndRead(page, '[data-open="files"]');
    expect(switched.title).toBe("files");
    expect(switched.running).toBe(0);
    expect(switched.opacity).toBe(1);
  });

  test("closing gives the canvas its width back at once and fades the panel out over it", async ({
    page,
  }) => {
    await pressAndRead(page, '[data-open="support"]');
    await settled(page);
    const closing = await pressAndRead(page, "[data-close]");
    expect(closing.canvasWidth).toBe(WIDTH);
    expect(closing.hidden).toBe(false);
    expect(closing.closing).toBe(true);
    expect(closing.title).toBe("support-agent");
    expect(closing.running).toBeGreaterThan(0);
    expect(closing.pointerReachesCanvas).toBe(true);
    await expect(page.locator(PANEL)).toBeHidden();
  });

  test("a node picked while the panel fades out takes it straight back", async ({
    page,
  }) => {
    await pressAndRead(page, '[data-open="support"]');
    await settled(page);
    await pressAndRead(page, "[data-close]");
    const back = await pressAndRead(page, '[data-open="files"]');
    expect(back.closing).toBe(false);
    expect(back.title).toBe("files");
    expect(back.inputTakesPointer).toBe(true);
    await settled(page);
    await expect(page.locator(PANEL)).toBeVisible();
    await expect(page.locator(PANEL)).toHaveCSS("opacity", "1");
  });

  test("under reduced motion it opens and closes with no transition", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const open = await pressAndRead(page, '[data-open="support"]');
    expect(open.running).toBe(0);
    expect(open.opacity).toBe(1);
    const closing = await pressAndRead(page, "[data-close]");
    expect(closing.running).toBe(0);
    await expect(page.locator(PANEL)).toBeHidden({ timeout: 100 });
  });

  test("the transitions add no layout work after the step", async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const layout = async (): Promise<{ count: number; ms: number }> => {
      const { metrics } = await cdp.send("Performance.getMetrics");
      const read = (name: string): number =>
        metrics.find((metric) => metric.name === name)?.value ?? 0;

      return { count: read("LayoutCount"), ms: read("LayoutDuration") * 1000 };
    };
    const twoFrames = (): Promise<void> =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    const during = async (
      button: string,
    ): Promise<{ step: number; after: number; afterMs: number }> => {
      const start = await layout();
      await pressAndRead(page, button);
      await twoFrames();
      const stepped = await layout();
      await page.waitForTimeout(400);
      const end = await layout();

      return {
        step: stepped.count - start.count,
        after: end.count - stepped.count,
        afterMs: end.ms - stepped.ms,
      };
    };

    const open = await during('[data-open="support"]');
    const close = await during("[data-close]");
    test.info().annotations.push({
      type: "layout",
      description: `open: ${open.step} in its step, ${open.after} (${open.afterMs.toFixed(2)} ms) over the fade; close: ${close.step} in its step, ${close.after} (${close.afterMs.toFixed(2)} ms) over the fade and hide`,
    });
    expect(open.after).toBeLessThanOrEqual(1);
    // The hide at the end of the fade is the one layout a close adds.
    expect(close.after).toBeLessThanOrEqual(2);
  });
});

test.describe("popups", () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page, "motion");
  });

  const timing = (page: Page, selector: string) =>
    page.locator(selector).evaluate((element) => {
      const style = getComputedStyle(element);

      return {
        duration: style.transitionDuration,
        property: style.transitionProperty,
      };
    });

  test("menus, tooltips, dialogs and sheets move only opacity, scale or translate, on the token durations", async ({
    page,
  }) => {
    expect(
      (await timing(page, 'nav[aria-label="Motion"] [data-close]')).duration,
    ).toBe("0.12s");

    await page.getByRole("button", { name: "Menu" }).click();
    const menu = '[data-slot="dropdown-menu-content"]';
    await expect(page.locator(menu)).toBeVisible();
    expect(await timing(page, menu)).toEqual({
      duration: "0.16s",
      property: "opacity, scale",
    });
    await page.keyboard.press("Escape");
    await expect(page.locator(menu)).toHaveCount(0);

    await page.getByRole("button", { name: "About this fixture" }).hover();
    const tooltip = '[data-slot="tooltip-content"]';
    await expect(page.locator(tooltip)).toBeVisible();
    expect((await timing(page, tooltip)).property).toBe("opacity, scale");
    await page.mouse.move(WIDTH / 2, 400);
    await expect(page.locator(tooltip)).toHaveCount(0);

    await page.getByRole("button", { name: "Dialog" }).click();
    const dialog = '[data-slot="dialog-content"]';
    await expect(page.locator(dialog)).toBeVisible();
    expect(await timing(page, dialog)).toEqual({
      duration: "0.2s",
      property: "opacity, scale",
    });
    expect((await timing(page, '[data-slot="dialog-overlay"]')).property).toBe(
      "opacity",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator(dialog)).toHaveCount(0);

    await page.getByRole("button", { name: "Sheet" }).click();
    const sheet = '[data-slot="sheet-content"]';
    await expect(page.locator(sheet)).toBeVisible();
    expect(await timing(page, sheet)).toEqual({
      duration: "0.2s",
      property: "translate",
    });
  });

  test("a menu scales as it fades in, and does neither under reduced motion", async ({
    page,
  }) => {
    const menu = page.locator('[data-slot="dropdown-menu-content"]');
    // Base UI drops `data-starting-style`, starting the transitions, a frame after mount.
    const opened = (): Promise<string[]> =>
      page.evaluate(async () => {
        document
          .querySelector<HTMLButtonElement>(
            'nav[aria-label="Motion"] button[aria-haspopup="menu"]',
          )
          ?.click();
        for (let frame = 0; frame < 10; frame++) {
          const running = (
            document
              .querySelector('[data-slot="dropdown-menu-content"]')
              ?.getAnimations() ?? []
          ).flatMap((animation) =>
            animation instanceof CSSTransition
              ? [animation.transitionProperty]
              : [],
          );
          if (running.length > 0) return running;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }

        return [];
      });

    expect((await opened()).sort()).toEqual(["opacity", "scale"]);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await opened()).toEqual([]);
    await expect(menu).toBeVisible();
  });
});
