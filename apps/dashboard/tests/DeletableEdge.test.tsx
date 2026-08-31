import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EdgeProps } from "@xyflow/react";

mock.module("@xyflow/react", () => ({
  BaseEdge: ({ style }: { style?: React.CSSProperties }) => (
    <path data-edge-path="true" style={style} />
  ),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-edge-label-renderer="true">{children}</div>
  ),
  getSmoothStepPath: () => ["M 0 0", 10, 20],
  useReactFlow: () => ({ deleteElements: async () => undefined }),
  useStore: (
    selector: (state: {
      edges: Array<{ id: string; source: string; target: string }>;
      nodeLookup: Map<string, { data: {}; type: string }>;
    }) => unknown,
  ) =>
    selector({
      edges: [{ id: "edge", source: "agent", target: "sandbox" }],
      nodeLookup: new Map([
        ["agent", { data: {}, type: "agent" }],
        ["sandbox", { data: {}, type: "sandbox" }],
      ]),
    }),
}));

mock.module("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

const { DeletableEdge } =
  await import("../app/components/canvas/DeletableEdge");

test("dims the default label with its edge", () => {
  const markup = renderToStaticMarkup(
    <DeletableEdge
      {...({
        id: "edge",
        source: "agent",
        sourcePosition: "bottom",
        sourceX: 0,
        sourceY: 0,
        style: { opacity: 0.12 },
        target: "sandbox",
        targetPosition: "top",
        targetX: 100,
        targetY: 100,
      } as unknown as EdgeProps)}
    />,
  );
  const defaultLabel = markup.match(/<div[^>]*>default<\/div>/)?.[0];

  expect(defaultLabel).toContain("opacity:0.12");
});
