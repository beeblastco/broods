import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const RULE = "broods/no-inline-schema-compile";
const rule = ruleTester(RULE, { filename: "fixture.tsx" });
const HOIST = "Hoist this zod schema to a module-level const";

describe(RULE, () => {
  rule.valid(
    "allows schemas at module scope, recursive ones included",
    `
      import { z } from "zod";

      const MAX = 64;
      const frame = z.object({ type: z.literal("exec"), args: z.array(z.string()).max(MAX) });
      type Node = { children: Node[] };
      const node: z.ZodType<Node> = z.lazy(() => z.object({ children: z.array(node) }));
      const category = z.object({
        name: z.string(),
        get children() {
          return z.array(category);
        },
      });
      const limits = (() => z.object({ max: z.number() }))();
      export const parseFrame = (input: unknown) => frame.parse(input);
      export const schemas = { node: node, category: category, limits: limits };
    `,
  );

  rule.valid(
    "allows factories that build a schema from their arguments",
    `
      import { z } from "zod";

      export function idField(key: string) {
        return z.string().min(1).describe(\`The \${key}.\`);
      }
      export const custom = <T,>() => z.custom<T>();
      export function withBody(base: z.ZodObject) {
        const body = z.record(z.string(), base);
        return z.object({ body: body });
      }
      export const makeHandler = (max: number) => (input: unknown) =>
        z.number().max(max).parse(input);
      export class Limits {
        max = 5;
        schema() {
          return z.number().max(this.max).describe("Use this limit.");
        }
      }
    `,
  );

  rule.valid(
    "allows schemas built in code that runs once at startup",
    `
      import { z } from "zod";

      export function createServer(server: { tool: (name: string, input: object) => void }) {
        server.tool("list-runs", { limit: z.number().int().positive().max(100).optional() });
        register(server);
      }
      function register(server: { tool: (name: string, input: object) => void }) {
        const body = z.record(z.string(), z.unknown());
        server.tool("create", { body: body, confirm: z.boolean() });
      }
      export class Registry {
        register() {
          return { inputSchema: z.strictObject({}) };
        }
      }
    `,
  );

  rule.valid(
    "ignores zod helpers that do not build a schema",
    `
      import { z } from "zod";

      const input = z.object({ name: z.string() });
      export function explain(value: unknown): string {
        const parsed = input.safeParse(value);
        return parsed.success ? "" : z.prettifyError(parsed.error);
      }
    `,
  );

  rule.valid(
    "ignores files that do not import zod",
    `
      const z = { object: (shape: object) => shape };
      export const build = () => z.object({});
    `,
  );

  rule.invalid(
    "reports a static schema built in a handler, once per expression",
    `
      import { z } from "zod";

      export async function handle(request: Request) {
        const body = z.object({ name: z.string().min(1) }).parse(await request.json());
        return body.name;
      }
    `,
    [{ line: 4, message: HOIST }],
  );

  rule.invalid(
    "reports static schemas in components, hooks and event handlers",
    `
      import * as z from "zod/mini";

      export function Panel() {
        const output = z.looseObject({ type: z.literal("content") });
        return output.def.type;
      }
      export const useFrame = () => z.strictObject({});
      export class Socket {
        onMessage(data: string) {
          return z.string().parse(data);
        }
      }
    `,
    [
      { line: 4, message: HOIST },
      { line: 7, message: HOIST },
      { line: 10, message: HOIST },
    ],
  );

  rule.invalid(
    "reports static schemas in loops and iteration callbacks",
    `
      import { z } from "zod";

      export function parseAll(rows: unknown[], fields: string[]) {
        for (const row of rows) z.object({ id: z.string() }).parse(row);
        const names = fields.map((field) => z.string().describe(field));
        return rows.filter((row) => z.number().safeParse(row).success).concat(names);
      }
      export const fetchRow = (request: Request) => z.object({}).parse(request);
    `,
    [
      { line: 4, message: HOIST },
      { line: 6, message: HOIST },
      { line: 8, message: HOIST },
    ],
  );

  rule.invalid(
    "reports a schema rebuilt in a refine callback and named imports",
    `
      import { object, string } from "zod/mini";
      import { z } from "zod";

      export const handle = () => object({ name: string() });
      export const token = z.string().refine((value) => z.string().min(1).safeParse(value).success);
    `,
    [
      { line: 4, message: HOIST },
      { line: 5, message: HOIST },
    ],
  );
});
