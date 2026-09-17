import { expect, test, type Locator } from "@playwright/test";
import { openGallery } from "../lib/gallery";

type Box = { height: number; width: number; x: number; y: number };

/** What sits on top at one point sampled along an edge's line. */
type Hit = {
  at: DOMPoint;
  control: string | null | undefined;
  edge: string | null | undefined;
  /** A card at the line's first or last sample, where the edge meets it. */
  end: boolean;
};

type Point = { x: number; y: number };

const AGENTS = ["tracy", "coder", "reviewer"];

// Chips are measured against frames on screen; a pixel of slack covers the
// sub-pixel rounding of the fitted zoom.
const SLACK = 1;

// How far an edge's end may sit from a box side: the handle straddles it.
const HANDLE_SLACK = 8;

// Two runs closer than this, in flow units, draw over each other.
const OVERLAP_DISTANCE = 2;

// Longest stretch, in flow units, two edges may share before it counts.
const OVERLAP_LENGTH = 8;

// How far outside its box a handle's edge end may sit, in flow units: React
// Flow draws the handle straddling the border, plus rounding.
const HANDLE_OFFSET = 6;

// Distance between the points sampled along an edge path, in flow units.
const PATH_STEP = 4;

// NODE_WIDTH by NODE_HEIGHT and FRAME_CHIP_HEIGHT, the one size each box draws.
const CARD_SIZE = { height: 96, width: 176 };
const CHIP_HEIGHT = 44;

test("groups of one are cards, chips sit inside frames, a collapsed frame is one card", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-frames"]');
  const chips = fixture.locator('[data-slot="resource-chip"]');
  const frames = fixture.locator('[data-slot="canvas-frame"]');
  const expanded = fixture.locator(
    '[data-slot="canvas-frame"][data-collapsed="false"]',
  );
  const collapsed = fixture.locator(
    '[data-slot="canvas-frame"][data-collapsed="true"]',
  );

  // Computers (2), tracy's workspaces (2), shared workspaces (2).
  await expect(chips).toHaveCount(6);
  await expect(expanded).toHaveCount(3);
  await expect(collapsed).toHaveCount(1);
  await expect(collapsed).toContainText("github, linear");
  // The lone cloud sandbox, hosted and machine servers stay cards.
  for (const id of ["internal-sandbox", "search", "blender"]) {
    const card = fixture.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('[data-slot="resource-chip"]')).toHaveCount(0);
  }
  await expect(
    fixture.locator('.react-flow__node[data-id="internal-sandbox"]'),
  ).toContainText("1 · default");
  for (const frame of await frames.all()) {
    const count = Number(
      await frame.locator("span.tabular-nums").first().innerText(),
    );
    expect(count).toBeGreaterThanOrEqual(2);
  }

  const frameBoxes = await Promise.all(
    (await expanded.all()).map(async (frame): Promise<Box> => boxOf(frame)),
  );
  for (const chip of await chips.all()) {
    const box = await boxOf(chip);
    const inside = frameBoxes.some(
      (frame): boolean =>
        box.x >= frame.x - SLACK &&
        box.y >= frame.y - SLACK &&
        box.x + box.width <= frame.x + frame.width + SLACK &&
        box.y + box.height <= frame.y + frame.height + SLACK,
    );
    expect(inside, await chip.innerText()).toBe(true);
  }
});

test("every card is one size, every group row another, whatever the card says", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-frames"]');
  await fixture.getByRole("button", { name: "Expand MCP · url" }).click();
  const zoom = await flowScale(fixture);

  // Cards: agents, the lone sandbox, the session store, the ungrouped servers.
  const cards = await fixture.locator('[data-slot="card"]').all();
  expect(cards.length).toBeGreaterThan(4);
  for (const card of cards) {
    const box = await boxOf(card);
    expect(
      [round(box.width / zoom), round(box.height / zoom)],
      await card.innerText(),
    ).toEqual([CARD_SIZE.width, CARD_SIZE.height]);
  }

  // Rows inside a group: a card's width, and one height for every kind.
  const chips = await fixture.locator('[data-slot="resource-chip"]').all();
  expect(chips.length).toBeGreaterThan(4);
  for (const chip of chips) {
    const box = await boxOf(chip);
    expect(
      [round(box.width / zoom), round(box.height / zoom)],
      await chip.innerText(),
    ).toEqual([CARD_SIZE.width, CHIP_HEIGHT]);
  }

  // A collapsed group is a card, at a card's size.
  const frame = fixture.locator(
    '.react-flow__node[data-id="frame:tracy:workspace:s3"]',
  );
  await frame.getByRole("button", { name: "Collapse Workspaces" }).click();
  const collapsedBox = await boxOf(frame);
  expect([
    round(collapsedBox.width / zoom),
    round(collapsedBox.height / zoom),
  ]).toEqual([CARD_SIZE.width, CARD_SIZE.height]);
});

test("chip names and status lines fit without truncating", async ({ page }) => {
  await openGallery(page);
  const clipped = await page
    .locator(
      '[data-fixture="canvas-frames"] [data-slot="resource-chip"] .truncate',
    )
    .evaluateAll((spans): (string | null)[] =>
      spans
        .filter((span): boolean => span.scrollWidth > span.clientWidth)
        .map((span): string | null => span.textContent),
    );

  expect(clipped).toEqual([]);
});

test("mount, inherited and runs-on edges end on the two resources they join, with arrows", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-frames"]');

  for (const [id, ends, arrow] of [
    [
      "mount:internal-sandbox-right-notes-left",
      ["internal-sandbox", "notes"],
      true,
    ],
    ["inherits:repos-internal-sandbox", ["repos", "internal-sandbox"], true],
    ["runs-on:blender-kien-mac", ["blender", "kien-mac"], false],
  ] as const) {
    const path = fixture.locator(
      `.react-flow__edge[data-id="${id}"] path.react-flow__edge-path`,
    );
    // A path, not visibility: a mount between level handles is a flat line.
    await expect(path, id).toHaveCount(1);
    const endpoints = await path.evaluate(
      (element: SVGPathElement): Point[] => {
        const matrix = element.getScreenCTM();
        if (!matrix) return [];

        return [0, element.getTotalLength()].map((at): Point => {
          const point = element.getPointAtLength(at).matrixTransform(matrix);

          return { x: point.x, y: point.y };
        });
      },
    );
    expect(endpoints).toHaveLength(2);
    expect(
      Math.hypot(
        endpoints[1].x - endpoints[0].x,
        endpoints[1].y - endpoints[0].y,
      ),
      `${id} length`,
    ).toBeGreaterThan(HANDLE_SLACK);
    if (arrow) {
      const marker = await path.evaluate((element: SVGPathElement): boolean => {
        const url = element.getAttribute("marker-end") ?? "";
        const markerId = /url\(#(.+)\)/.exec(url)?.[1];

        return (
          markerId !== undefined && document.getElementById(markerId) !== null
        );
      });
      expect(marker, `${id} arrow`).toBe(true);
    }
    const boxes = await Promise.all(
      ends.map(async (end): Promise<Box> =>
        boxOf(
          fixture.locator(`.react-flow__node[data-id="${end}"] > div`).first(),
        ),
      ),
    );
    // Each end sits on a side of one of the two boxes, one end per box.
    const boxAt = endpoints.map((point): number =>
      boxes.findIndex(
        (box): boolean =>
          point.y >= box.y &&
          point.y <= box.y + box.height &&
          (Math.abs(point.x - box.x) <= HANDLE_SLACK ||
            Math.abs(point.x - (box.x + box.width)) <= HANDLE_SLACK),
      ),
    );
    expect([...boxAt].sort(), `${id} ends`).toEqual([0, 1]);
  }
});

test("every agent edge leaves the agent's bottom, enters its target's top and crosses no other box", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-frames"]');
  await expect(
    fixture.locator('.react-flow__edge[data-id^="bundle:"]'),
  ).toHaveCount(5);

  const problems = await fixture.evaluate(
    (root, options): string[] => {
      const rects = new Map(
        [
          ...root.querySelectorAll<HTMLElement>(
            ".react-flow__node:not(.react-flow__node:has([data-slot='resource-chip']))",
          ),
        ].map((node): [string, DOMRect] => [
          node.dataset.id ?? "",
          node.getBoundingClientRect(),
        ]),
      );
      const edges = [
        ...root.querySelectorAll<SVGGElement>(".react-flow__edge-default"),
      ];

      return edges.flatMap((edge): string[] => {
        const id = edge.dataset.id ?? "";
        const agent = options.agents.find(
          (name) =>
            id.startsWith(`bundle:${name}:`) ||
            id.startsWith(`xy-edge__${name}-`),
        );
        if (!agent) return [`${id}: no agent`];
        const target = id.startsWith("bundle:")
          ? id.slice(`bundle:${agent}:`.length)
          : id.slice(`xy-edge__${agent}-`.length);
        const path = edge.querySelector<SVGPathElement>(
          "path.react-flow__edge-path",
        );
        const matrix = path?.getScreenCTM();
        const source = rects.get(agent);
        const end = rects.get(target);
        if (!path || !matrix || !source || !end) return [`${id}: missing`];
        const length = path.getTotalLength();
        const at = (distance: number): DOMPoint =>
          path.getPointAtLength(distance).matrixTransform(matrix);
        const found: string[] = [];
        // A handle sits a few flow px outside its box, so the tolerance
        // scales with the zoom: flow px times screen px per flow px.
        const slack = options.handleOffset * matrix.a + 1;
        // Within `slack` of the side's line, and between its two ends.
        const onSide = (point: DOMPoint, y: number, rect: DOMRect): boolean =>
          Math.abs(point.y - y) <= slack &&
          point.x >= rect.left &&
          point.x <= rect.right;
        const inside = (point: DOMPoint, rect: DOMRect): boolean =>
          point.x > rect.left + 1 &&
          point.x < rect.right - 1 &&
          point.y > rect.top + 1 &&
          point.y < rect.bottom - 1;
        if (!onSide(at(0), source.bottom, source)) {
          found.push(`${id} does not leave ${agent}'s bottom`);
        }
        if (!onSide(at(length), end.top, end)) {
          found.push(`${id} does not enter ${target}'s top`);
        }
        for (let distance = 0; distance <= length; distance += options.step) {
          const point = at(distance);
          for (const [boxId, rect] of rects) {
            if (boxId !== agent && boxId !== target && inside(point, rect)) {
              found.push(`${id} crosses ${boxId}`);
            }
          }
        }

        return [...new Set(found)];
      });
    },
    { agents: AGENTS, handleOffset: HANDLE_OFFSET, step: PATH_STEP },
  );

  expect(problems).toEqual([]);
});

test("mount, inherited and runs-on edges cross no box but the ones holding their ends", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-frames"]');
  await fixture.getByRole("button", { name: "Expand MCP · url" }).click();

  const problems = await fixture.evaluate((root, step): string[] => {
    const rects = [
      ...root.querySelectorAll<HTMLElement>(
        ".react-flow__node:not(.react-flow__node:has([data-slot='resource-chip']))",
      ),
    ].map((node) => ({
      id: node.dataset.id ?? "",
      rect: node.getBoundingClientRect(),
    }));
    const inside = (point: DOMPoint, rect: DOMRect, margin: number): boolean =>
      point.x > rect.left + margin &&
      point.x < rect.right - margin &&
      point.y > rect.top + margin &&
      point.y < rect.bottom - margin;
    const paths = [
      ...root.querySelectorAll<SVGPathElement>(
        ".react-flow__edge-mount path.react-flow__edge-path, .react-flow__edge-runsOn path.react-flow__edge-path",
      ),
    ];

    return paths.flatMap((path): string[] => {
      const id =
        path.closest<SVGGElement>(".react-flow__edge")?.dataset.id ?? "";
      const matrix = path.getScreenCTM();
      if (!matrix) return [`${id}: no path`];
      const length = path.getTotalLength();
      const at = (distance: number): DOMPoint =>
        path.getPointAtLength(distance).matrixTransform(matrix);
      // The boxes holding either end: a chip's frame, or a card itself.
      const ends = [at(0), at(length)];
      const allowed = new Set(
        rects
          .filter(({ rect }) => ends.some((end) => inside(end, rect, -8)))
          .map(({ id: boxId }) => boxId),
      );
      const hits = new Set<string>();
      for (let distance = 0; distance <= length; distance += step) {
        const point = at(distance);
        for (const { id: boxId, rect } of rects) {
          if (!allowed.has(boxId) && inside(point, rect, 1)) {
            hits.add(`${id} crosses ${boxId}`);
          }
        }
      }

      return [...hits];
    });
  }, PATH_STEP);

  expect(problems).toEqual([]);
});

test("every card draws within the height the tidy layout stacks it at", async ({
  page,
}) => {
  await openGallery(page);
  const overflowing = await page
    .locator('[data-fixture="canvas-frames"] [data-slot="card"]')
    .evaluateAll((cards): string[] =>
      cards.flatMap((card): string[] => {
        const header = card.querySelector<HTMLElement>(
          '[data-slot="card-header"]',
        );
        const status = card.querySelector<HTMLElement>(
          '[data-slot="card-status"]',
        );
        // offsetHeight ignores the zoom's counter-scale, so this is the height at scale 1.
        const drawn = (header?.offsetHeight ?? 0) + (status?.offsetHeight ?? 0);
        const estimate = Number(card.dataset.minHeight);

        return drawn > estimate + 1
          ? [`${card.textContent}: ${drawn} > ${estimate}`]
          : [];
      }),
    );

  expect(overflowing).toEqual([]);
});

test("edges of different agents or kinds never draw over each other", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-frames"]');
  // Every frame open, so every lane is on screen.
  await fixture.getByRole("button", { name: "Expand MCP · url" }).click();

  const { checked, overlaps } = await fixture.evaluate(
    (root, options): { checked: number; overlaps: string[] } => {
      const paths = [
        ...root.querySelectorAll<SVGPathElement>(
          ".react-flow__edge path.react-flow__edge-path",
        ),
      ].map((path) => {
        const id =
          path.closest<SVGGElement>(".react-flow__edge")?.dataset.id ?? "";
        const points: DOMPoint[] = [];
        for (let at = 0; at <= path.getTotalLength(); at += 1) {
          points.push(path.getPointAtLength(at));
        }
        // One agent's edges share a trunk on purpose; any other edge is its own.
        const agent = options.agents.find(
          (name) =>
            id.startsWith(`bundle:${name}:`) ||
            id.startsWith(`xy-edge__${name}-`),
        );

        return { id: id, owner: agent ?? id, points: points };
      });
      const cell = (x: number, y: number): string =>
        `${Math.floor(x / 4)}:${Math.floor(y / 4)}`;
      const found: string[] = [];
      for (const [index, a] of paths.entries()) {
        for (const b of paths.slice(index + 1)) {
          if (a.owner === b.owner) continue;
          const grid = new Map<string, DOMPoint[]>();
          for (const point of b.points) {
            const key = cell(point.x, point.y);
            grid.set(key, [...(grid.get(key) ?? []), point]);
          }
          let run = 0;
          for (const point of a.points) {
            const cx = Math.floor(point.x / 4);
            const cy = Math.floor(point.y / 4);
            let near = false;
            for (let dx = -1; dx <= 1 && !near; dx++) {
              for (let dy = -1; dy <= 1 && !near; dy++) {
                near = (grid.get(`${cx + dx}:${cy + dy}`) ?? []).some(
                  (other) =>
                    Math.hypot(other.x - point.x, other.y - point.y) <
                    options.distance,
                );
              }
            }
            run = near ? run + 1 : 0;
            if (run > options.length) {
              found.push(`${a.id} / ${b.id}`);
              break;
            }
          }
        }
      }

      return { checked: paths.length, overlaps: found };
    },
    { agents: AGENTS, distance: OVERLAP_DISTANCE, length: OVERLAP_LENGTH },
  );

  // Agent, bundle, mount, inherited, runs-on and sub-agent edges all drawn.
  expect(checked).toBe(14);
  expect(overlaps).toEqual([]);
});

test("a collapsed frame's dot follows its members", async ({ page }) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-frames"]');
  const mcp = fixture.locator(
    '.react-flow__node[data-id="frame:tracy:mcp:http"]',
  );

  // Both url servers are disabled: grey, never green.
  await expect(mcp.locator('[data-slot="frame-status"]')).toHaveClass(
    /bg-muted-foreground/,
  );

  for (const [frameId, label, members] of [
    [
      "frame:tracy:sandbox:machine",
      "Your computer",
      ["kien-mac", "phicks-mac"],
    ],
    ["frame:tracy:workspace:s3", "Workspaces", ["notes", "repos"]],
    ["frame:coder,tracy:workspace:s3", "Workspaces", ["handbook", "playbook"]],
  ] as const) {
    const colors = await Promise.all(
      members.map(async (id): Promise<string> =>
        dotColor(
          await fixture
            .locator(
              `.react-flow__node[data-id="${id}"] [data-slot="chip-status"]`,
            )
            .getAttribute("class"),
        ),
      ),
    );
    const expected = colors.reduce((best, color) =>
      colorRank(color) > colorRank(best) ? color : best,
    );
    const frame = fixture.locator(`.react-flow__node[data-id="${frameId}"]`);
    await frame.getByRole("button", { name: `Collapse ${label}` }).click();
    expect(
      dotColor(
        await frame.locator('[data-slot="frame-status"]').getAttribute("class"),
      ),
      frameId,
    ).toBe(expected);
  }
});

test("hovering any edge's line shows a lock or a trash: trash only where it can be deleted", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-frames"]');
  await fixture.getByRole("button", { name: "Expand MCP · url" }).click();

  // Stored and user-owned edges delete; code-managed and drawn ones lock and say why.
  expect(await hoverEveryEdge(fixture)).toEqual(
    expect.objectContaining({
      "inherits:repos-internal-sandbox": "locked",
      "mount:internal-sandbox-right-notes-left": "delete",
      "runs-on:blender-kien-mac": "locked",
      "subagent:coder-right-reviewer-left": "delete",
      "subagent:tracy-right-coder-left": "locked",
      "xy-edge__tracy-session": "delete",
    }),
  );
  for (const [id, reason] of [
    ["inherits:repos-internal-sandbox", /Inherited from the agent's default/],
    ["runs-on:blender-kien-mac", /runs on this computer/],
    ["subagent:tracy-right-coder-left", /Managed by broods\/ code/],
  ] as const) {
    await expect(
      fixture.locator(`[data-edge-id="${id}"][data-edge-control="locked"]`),
      id,
    ).toHaveAttribute("title", reason);
  }

  // Collapsed, the mount re-points to the frame: drawn, so locked.
  const frame = fixture.locator(
    '.react-flow__node[data-id="frame:tracy:workspace:s3"]',
  );
  await frame.getByRole("button", { name: "Collapse Workspaces" }).click();
  const collapsed = Object.entries(await hoverEveryEdge(fixture)).filter(
    ([id]) => id.startsWith("collapsed:"),
  );
  expect(collapsed.length).toBeGreaterThan(0);
  for (const [id, control] of collapsed) {
    expect(control, id).toBe("locked");
    await expect(
      fixture.locator(`[data-edge-id="${id}"][data-edge-control="locked"]`),
    ).toHaveAttribute("title", /Expand the group/);
  }
});

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();

  return box ?? { height: 0, width: 0, x: 0, y: 0 };
}

/** The precedence a collapsed frame applies: error, warn, active, idle. */
function colorRank(color: string): number {
  if (color === "bg-destructive") return 3;
  if (color === "bg-warning") return 2;
  if (color === "bg-success" || color === "bg-canvas-mount") return 1;

  return 0;
}

/** The bg-* class a status dot carries. */
function dotColor(className: string | null): string {
  return (
    (className ?? "").split(" ").find((name) => name.startsWith("bg-")) ?? ""
  );
}

/** React Flow's current zoom, so a measured box compares against its flow size. */
async function flowScale(fixture: Locator): Promise<number> {
  return fixture
    .locator(".react-flow__viewport")
    .evaluate(
      (viewport): number =>
        new DOMMatrix(getComputedStyle(viewport).transform).a,
    );
}

/**
 * Hovers each drawn edge on its line, never on its control (hovering a control
 * reveals it on its own), and returns which control that reveals. Fails an edge
 * with anything but exactly one control, or whose line the pointer can't reach.
 * Excepted: a line wholly under its own control, its own agent's shared trunk
 * or that trunk's controls, or a card at its end. There the edge on top takes
 * the hover, by design; a line over bare canvas never counts as covered.
 */
async function hoverEveryEdge(
  fixture: Locator,
): Promise<Record<string, string>> {
  const page = fixture.page();
  await fixture.scrollIntoViewIfNeeded();
  const ids = await fixture
    .locator(".react-flow__edge")
    .evaluateAll((edges): string[] =>
      edges.map((edge) => edge.getAttribute("data-id") ?? ""),
    );
  const controls: Record<string, string> = {};
  const unreachable: string[] = [];
  for (const id of ids) {
    const control = fixture.locator(
      `[data-edge-id="${id}"][data-edge-control]`,
    );
    await expect(control, `${id} control`).toHaveCount(1);
    controls[id] = (await control.getAttribute("data-edge-control")) ?? "";
    const { covered, point } = await fixture
      .locator(`.react-flow__edge[data-id="${id}"] path.react-flow__edge-path`)
      .evaluate(
        (
          path: SVGPathElement,
          options,
        ): { covered: boolean; point: Point | null } => {
          const matrix = path.getScreenCTM();
          if (!matrix) return { covered: false, point: null };
          const ownerOf = (edgeId: string): string | undefined =>
            options.agents.find(
              (name) =>
                edgeId.startsWith(`bundle:${name}:`) ||
                edgeId.startsWith(`xy-edge__${name}-`),
            );
          const owner = ownerOf(options.id);
          const hits = Array.from({ length: 19 }, (_, index): Hit => {
            const at = path
              .getPointAtLength((path.getTotalLength() * (index + 1)) / 20)
              .matrixTransform(matrix);
            const element = document.elementFromPoint(at.x, at.y);

            return {
              at: at,
              control: element
                ?.closest("[data-edge-control]")
                ?.getAttribute("data-edge-id"),
              edge: element
                ?.closest(".react-flow__edge")
                ?.getAttribute("data-id"),
              end:
                (index === 0 || index === 18) &&
                element?.closest(".react-flow__node") != null,
            };
          });
          const found = hits.find((hit): boolean => hit.edge === options.id);

          return {
            covered: hits.every(
              (hit): boolean =>
                hit.end ||
                hit.control === options.id ||
                (owner !== undefined &&
                  [hit.control, hit.edge].some(
                    (other): boolean =>
                      other != null && ownerOf(other) === owner,
                  )),
            ),
            point: found ? { x: found.at.x, y: found.at.y } : null,
          };
        },
        { agents: AGENTS, id: id },
      );
    if (!point) {
      if (!covered) unreachable.push(id);
      continue;
    }
    await page.mouse.move(point.x, point.y);
    await expect(control.locator("> *"), `${id} revealed`).toHaveCSS(
      "opacity",
      "1",
    );
    await page.mouse.move(0, 0);
  }
  expect(unreachable).toEqual([]);

  return controls;
}

/** Flow units, to the pixel: a fitted zoom leaves sub-pixel rounding behind. */
function round(value: number): number {
  return Math.round(value);
}
