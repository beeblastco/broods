import { defineRule } from "@oxlint/plugins";

import {
  arbitraryProperty,
  arbitraryValue,
  visitClassesAndStyles,
} from "../tailwind.ts";

const LAYOUT_PROPERTY_PATTERN =
  /^(?:all|(?:(?:min|max)-)?(?:width|height|inline-size|block-size)|inset(?:-[a-z-]+)?|top|right|bottom|left|(?:margin|padding)(?:-[a-z-]+)?|(?:row-|column-)?gap|flex(?:-basis|-grow|-shrink)?|grid-template(?:-[a-z]+)?)$/u;
const TIMING_PATTERN =
  /^(?:-?[\d.]+m?s|ease(?:-in|-out|-in-out)?|linear|steps|cubic-bezier|step-start|step-end|allow-discrete|normal)$/u;

const withoutFunctions = (value: string): string => {
  let current = value;
  for (let previous = ""; previous !== current;) {
    previous = current;
    current = current.replace(/\([^()]*\)/gu, "");
  }
  return current;
};

const listedProperties = (value: string): Array<string> =>
  value
    .toLowerCase()
    .split(",")
    .map((item) => item.trim());

const shorthandProperties = (value: string): Array<string> =>
  withoutFunctions(value.toLowerCase())
    .split(",")
    .map(
      (item) =>
        item
          .trim()
          .split(/\s+/u)
          .find((part) => part !== "" && !TIMING_PATTERN.test(part)) ?? "all",
    );

const declaredProperties = (name: string, value: string): Array<string> => {
  if (name === "transition") return shorthandProperties(value);
  if (name === "transition-property") return listedProperties(value);
  return [];
};

const animatesLayout = (properties: Array<string>): boolean =>
  properties.some((property) => LAYOUT_PROPERTY_PATTERN.test(property));

const isLayoutTransition = (utility: string): boolean => {
  if (utility === "transition-all") return true;
  const value = arbitraryValue(utility, "transition-");
  if (value !== undefined) return animatesLayout(listedProperties(value));
  const property = arbitraryProperty(utility);
  return (
    property !== undefined &&
    animatesLayout(declaredProperties(property.name, property.value))
  );
};

const message = (what: string): string =>
  `Use transition-[opacity,transform], transition-transform, transition-opacity or transition-colors: \`${what}\` can animate layout, which relays out the page on every frame.`;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow transitions that animate layout properties, in class strings and inline styles.",
    },
  },
  create: (context) =>
    visitClassesAndStyles(context, {
      matchesClass: isLayoutTransition,
      matchesDeclaration: (name, value) =>
        animatesLayout(declaredProperties(name, value)),
      message: message,
    }),
});
