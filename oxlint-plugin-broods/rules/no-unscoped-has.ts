import { defineRule } from "@oxlint/plugins";

import { visitStrings } from "../tailwind.ts";

const COMBINATOR_PATTERN = /[\s>+~]/u;
const NARROWING_PATTERN = /[.#[]|^[a-z]/iu;
const ROOT_COMPOUND_PATTERN = /^(?:html|body|:root)(?![\w-])/iu;
const GROUP_PREFIX_PATTERN = /(?:^|:)(?:group|peer)-$/u;
const ANCESTOR_PREFIX_PATTERN = /(?:^|:)in-$/u;
const ATTRIBUTE_PREFIX_PATTERN = /(?:^|:)(?:data|aria)-$/u;
const QUOTED_PATTERN = /(["'])(?:\\.|(?!\1).)*\1/gu;
const VARIANT_END_PATTERN = /^(?:\/[\w-]+)?:/u;

interface VariantGroup {
  readonly prefix: string;
  readonly group: string;
}

const variantGroups = (token: string): Array<VariantGroup> => {
  const groups: Array<VariantGroup> = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < token.length; index++) {
    const char = token[index];
    if (char === "[") {
      if (depth === 0) start = index + 1;
      depth++;
    } else if (char === "]" && depth > 0) {
      depth--;
      if (depth === 0 && VARIANT_END_PATTERN.test(token.slice(index + 1))) {
        groups.push({
          prefix: token.slice(0, start - 1),
          group: token.slice(start, index),
        });
      }
    }
  }
  return groups;
};

const closingParen = (selector: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < selector.length; index++) {
    if (selector[index] === "(") depth++;
    else if (selector[index] === ")" && --depth === 0) return index;
  }
  return selector.length;
};

const isWrapperSubject = (selector: string, from: number): boolean => {
  let depth = 0;
  for (let index = from; index < selector.length; index++) {
    const char = selector[index] ?? "";
    if (char === "(") depth++;
    else if (char === ")") {
      if (depth === 0) return true;
      depth--;
    } else if (depth > 0) continue;
    else if (char === ",") return true;
    else if (COMBINATOR_PATTERN.test(char)) {
      const next = selector.slice(index).trimStart()[0];
      if (
        /\s/u.test(char) &&
        (next === undefined || next === ")" || next === ",")
      ) {
        continue;
      }
      return false;
    }
  }
  return true;
};

const hasCompounds = (selector: string): Array<string> => {
  const compounds: Array<string> = [];
  let index = selector.indexOf(":has(");
  while (index !== -1) {
    let compound = "";
    let depth = 0;
    let subjectEnd = closingParen(selector, index + ":has".length) + 1;
    let skippingBranch = false;
    for (let position = index - 1; position >= 0; position--) {
      const char = selector[position] ?? "";
      if (char === ")") depth++;
      else if (char === "(") {
        if (depth > 0) depth--;
        else {
          if (!isWrapperSubject(selector, subjectEnd)) break;
          skippingBranch = false;
          subjectEnd = closingParen(selector, position) + 1;
        }
      } else if (depth === 0 && char === ",") {
        skippingBranch = true;
        continue;
      } else if (
        depth === 0 &&
        !skippingBranch &&
        COMBINATOR_PATTERN.test(char)
      ) {
        break;
      }
      if (!skippingBranch) compound = char + compound;
    }
    compounds.push(compound);
    index = selector.indexOf(":has(", index + 1);
  }
  return compounds;
};

const withoutNegations = (compound: string): string => {
  let result = "";
  let index = 0;
  while (index < compound.length) {
    if (!compound.startsWith(":not(", index)) {
      result += compound[index];
      index++;
      continue;
    }
    let depth = 0;
    for (index += ":not".length; index < compound.length; index++) {
      if (compound[index] === "(") depth++;
      else if (compound[index] === ")" && --depth === 0) break;
    }
    index++;
  }
  return result;
};

const unscopedHasVariants = (text: string): Array<string> => {
  if (!text.toLowerCase().includes(":has(")) return [];
  const offenders: Array<string> = [];
  for (const token of text.split(/\s+/u)) {
    for (const { prefix, group } of variantGroups(token)) {
      if (ATTRIBUTE_PREFIX_PATTERN.test(prefix)) continue;
      const relative = group
        .toLowerCase()
        .replace(QUOTED_PATTERN, '""')
        .replaceAll("_", " ");
      const owner = GROUP_PREFIX_PATTERN.test(prefix) ? ".group" : ".self";
      const selector = ANCESTOR_PREFIX_PATTERN.test(prefix)
        ? `:is(${relative.replaceAll("&", "*")}) .self`
        : relative.includes("&")
          ? relative.replaceAll("&", owner)
          : `${owner}:is(${relative})`;
      const unscoped = hasCompounds(selector).some((compound) => {
        const anchor = withoutNegations(compound);
        return (
          !NARROWING_PATTERN.test(anchor) || ROOT_COMPOUND_PATTERN.test(anchor)
        );
      });
      if (unscoped) offenders.push(`[${group}]`);
    }
  }
  return offenders;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Tailwind arbitrary variants with a :has() not anchored to a class, attribute, id or tag.",
    },
  },
  create: (context) =>
    visitStrings((text, node) => {
      for (const variant of unscopedHasVariants(text)) {
        context.report({
          node: node,
          message: `Anchor the :has() in ${variant} to a class, attribute, id or tag below the document root, or use a has-* variant: the browser checks an unanchored :has() on every ancestor, so any DOM change restyles the whole page.`,
        });
      }
    }),
});
