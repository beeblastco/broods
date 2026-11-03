import {
  v,
  type GenericValidator,
  type Validator,
  type Value,
} from "convex/values";
import { validate, ValidationError } from "convex-helpers/validators";
import { z } from "zod/mini";

import type { FlatPatch } from "./agentConfigCodec";
import { AGENT_CONFIG, MODEL_OUTPUT } from "./agentRules";
import { ClientError } from "./clientError";

// What a zod output is once Convex holds it: literals widen and a loose object is an open record.
type Stored<T> = unknown extends T
  ? Value
  : T extends string
    ? string
    : T extends number
      ? number
      : T extends boolean
        ? boolean
        : T extends null | undefined
          ? T
          : T extends readonly (infer Item)[]
            ? Stored<Item>[]
            : string extends keyof T
              ? Record<string, Stored<T[string]>>
              : { [Key in keyof T]: Stored<T[Key]> };

type Column<Schema extends z.core.$ZodType> = Validator<
  Stored<z.output<Schema>>,
  "required",
  string
>;

// The codec stores only the known branches, so the top level is closed where AGENT_CONFIG is loose.
const STORED_AGENT_CONFIG = z.strictObject(AGENT_CONFIG.shape);

// Rows keep `${ENV}` placeholders until core injects env: a column checks shape, never refinements.
// The casts hold because storedShape maps each schema kind the way Stored maps its output.
export const agentExtraConfigColumn = storedShape(
  STORED_AGENT_CONFIG,
) as Column<typeof STORED_AGENT_CONFIG>;
export const agentOutputFormatColumn = storedShape(MODEL_OUTPUT) as Column<
  typeof MODEL_OUTPUT
>;

// A sync checks every agent before it writes one, so the caller gets the path, not a 500.
export function assertStoredAgentConfig(flat: FlatPatch): void {
  assertColumn(agentExtraConfigColumn, flat.extraConfig ?? {}, "config");
  if (flat.outputFormat !== undefined)
    assertColumn(
      agentOutputFormatColumn,
      flat.outputFormat,
      "config.model.output",
    );
}

function assertColumn(
  column: GenericValidator,
  value: unknown,
  root: string,
): void {
  try {
    validate(column, value, { throw: true });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;

    throw new ClientError(
      `${root}${error.path ? `.${error.path}` : ""} must be ${error.expected}, got ${error.got}`,
    );
  }
}

function storedLiteral(
  values: ReadonlySet<unknown> | undefined,
): GenericValidator {
  if (!values || ![...values].every((value) => typeof value === "string"))
    throw new Error("only string literals have a stored Convex shape");

  return v.string();
}

// Enum keys stay a closed object, as zod refuses any other key; free keys stay a record.
function storedRecord(schema: z.core.$ZodRecord): GenericValidator {
  const { keyType, valueType } = schema._zod.def;
  const value = storedShape(valueType);
  const keys = (
    keyType instanceof z.core.$ZodPipe ? keyType._zod.def.out : keyType
  )._zod.values;

  return keys
    ? v.object(
        Object.fromEntries(
          [...keys].map((key) => [String(key), v.optional(value)]),
        ),
      )
    : v.record(v.string(), value);
}

function storedShape(schema: z.core.$ZodType): GenericValidator {
  if (schema instanceof z.core.$ZodString) return v.string();
  if (schema instanceof z.core.$ZodNumber) return v.number();
  if (schema instanceof z.core.$ZodBoolean) return v.boolean();
  if (schema instanceof z.core.$ZodUnknown) return v.any();
  if (schema instanceof z.core.$ZodLiteral || schema instanceof z.core.$ZodEnum)
    return storedLiteral(schema._zod.values);
  if (
    schema instanceof z.core.$ZodOptional ||
    schema instanceof z.core.$ZodCatch
  )
    return storedShape(schema._zod.def.innerType);
  if (schema instanceof z.core.$ZodNullable)
    return v.union(storedShape(schema._zod.def.innerType), v.null());
  if (schema instanceof z.core.$ZodArray)
    return v.array(storedShape(schema._zod.def.element));
  if (schema instanceof z.core.$ZodPipe) {
    const { in: input, out } = schema._zod.def;

    return storedShape(out instanceof z.core.$ZodTransform ? input : out);
  }
  if (schema instanceof z.core.$ZodUnion)
    return storedUnion(schema._zod.def.options.map(storedShape));
  if (schema instanceof z.core.$ZodRecord) return storedRecord(schema);
  if (schema instanceof z.core.$ZodObject) {
    const { catchall, shape } = schema._zod.def;
    if (catchall instanceof z.core.$ZodUnknown)
      return v.record(v.string(), v.any());

    return v.object(
      Object.fromEntries(
        Object.entries(shape).map(
          ([key, field]): [string, GenericValidator] => [
            key,
            field instanceof z.core.$ZodOptional
              ? v.optional(storedShape(field._zod.def.innerType))
              : storedShape(field),
          ],
        ),
      ),
    );
  }

  throw new Error(
    `a ${schema._zod.def.type} schema has no stored Convex shape`,
  );
}

function storedUnion(members: GenericValidator[]): GenericValidator {
  const unique = [
    ...new Map(
      members.map((member) => [JSON.stringify(member), member]),
    ).values(),
  ];

  const [only, ...others] = unique;

  return only && others.length === 0 ? only : v.union(...unique);
}
