import { z } from "zod/mini";

import { ClientError } from "./clientError";
import { stringValues } from "./storedJson";

type Issue = z.core.$ZodIssue;
type RawIssue = z.core.$ZodRawIssue;

export const nonEmptyString = z
  .string({ error: "must be a non-empty string" })
  .check(
    z.refine((value): boolean => value.trim().length > 0, {
      error: "must be a non-empty string",
    }),
  );

export const nonEmptyStrings = wholeValue(
  z.array(nonEmptyString),
  "must be an array of non-empty strings",
);

// Skill files a CLI manifest declares without bytes; an upload holds them back to back, in order.
export const skillFileDeclarations = z.array(
  z.object({
    path: z.string(),
    size: z.int().check(z.nonnegative()),
    sha256: z.string(),
    contentType: z.optional(z.string()),
  }),
);

// The `{ name, description, config }` body every config resource is created with.
export const resourceCreateInput = z.looseObject(
  {
    name: nonEmptyString,
    description: z.optional(z.string()),
    config: z.optional(z.unknown()),
  },
  { error: "Request body must be an object" },
);

// An update body: `config` is a patch, merged into the stored config before it is checked.
export const resourceUpdateInput = z.looseObject(
  {
    name: z.optional(nonEmptyString),
    description: z.optional(z.nullable(z.string())),
    config: z.optional(z.unknown()),
  },
  { error: "Request body must be an object" },
);

// Untrusted JSON in: the first issue throws as `${root}${path} ${message}`.
// A root ending in a space reads as prose: "policy document " + version.
export function parseInput<S extends z.core.$ZodType>(
  schema: S,
  value: unknown,
  root: string,
): z.output<S> {
  const result = z.safeParse(schema, value, { error: defaultMessage });
  if (result.success) return result.data;
  const [issue] = result.error.issues;

  throw new ClientError(issueSentence(issue, root));
}

export function positiveInteger(max: number): z.ZodMiniNumber {
  const error = `must be an integer from 1 to ${max}`;

  return z
    .number({ error: error })
    .check(
      z.refine(
        (value): boolean =>
          Number.isSafeInteger(value) && value >= 1 && value <= max,
        { error: error },
      ),
    );
}

// zod drops an own `__proto__` key unchecked; a keyed record must still refuse it by name.
export function refusingProtoKey<T>(
  schema: z.ZodMiniType<T>,
  error: string,
): z.ZodMiniType<T> {
  return z.pipe(
    z.unknown().check(
      z.superRefine((value, ctx): void => {
        if (
          typeof value === "object" &&
          value !== null &&
          Object.hasOwn(value, "__proto__")
        )
          ctx.addIssue({ code: "custom", path: ["__proto__"], message: error });
      }),
    ),
    schema,
  );
}

export function stringRecord(
  error: string,
): z.ZodMiniType<Record<string, string>> {
  return wholeValue(stringValues, error);
}

export function unsupportedKeys(
  keys: readonly string[],
): z.core.$ZodCheck<Record<string, unknown>> {
  return z.superRefine((input, ctx): void => {
    for (const key of Object.keys(input)) {
      if (!keys.includes(key))
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "is not supported",
        });
    }
  });
}

// Any issue inside `schema` reports once, on the value itself, worded `error`.
// A catch, not a nested parse, so `z.compile` inlines `schema`; the issue keeps no input.
export function wholeValue<T>(
  schema: z.ZodMiniType<T>,
  error: string,
): z.ZodMiniType<T> {
  return z.pipe(
    // oxlint-disable-next-line promise/valid-params -- zod's catch, not Promise#catch
    z.catch(schema, z.NEVER),
    z.transform((value, ctx): T => {
      if (value !== z.NEVER) return value;
      ctx.issues.push({ code: "custom", message: error, input: undefined });

      return z.NEVER;
    }),
  );
}

function defaultMessage(issue: RawIssue): string {
  if (issue.code === "invalid_value")
    return `must be one of: ${issue.values.join(", ")}`;
  if (issue.code === "invalid_key")
    return issue.issues[0]?.message ?? "is invalid";
  if (issue.code === "unrecognized_keys")
    return `has unknown option "${issue.keys[0]}"`;
  if (issue.code !== "invalid_type") return "is invalid";
  if (issue.expected === "object" || issue.expected === "record")
    return "must be an object";
  if (issue.expected === "array") return "must be an array";
  if (issue.expected === "int") return "must be an integer";

  return `must be a ${issue.expected}`;
}

// A failed union reports the branch the input's type matched; with none, its own message.
function issueSentence(issue: Issue | undefined, root: string): string {
  if (issue?.code === "invalid_union") {
    const branch = issue.errors.find(
      ([first]) =>
        first && !(first.code === "invalid_type" && !first.path.length),
    );
    const [first] = branch ?? [];
    if (first) {
      return issueSentence(
        { ...first, path: [...issue.path, ...first.path] },
        root,
      );
    }
  }
  const path = issue?.path ?? [];
  const message = (issue?.message ?? "is invalid").replaceAll(
    "{parent}",
    renderPath(root, path.slice(0, -1)),
  );

  return `${renderPath(root, path).trimEnd()} ${message}`.trim();
}

function renderPath(root: string, path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (rendered, key) =>
      typeof key === "number"
        ? `${rendered}[${key}]`
        : rendered && !rendered.endsWith(" ")
          ? `${rendered}.${String(key)}`
          : `${rendered}${String(key)}`,
    root,
  );
}
