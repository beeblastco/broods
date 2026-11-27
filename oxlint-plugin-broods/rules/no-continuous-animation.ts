import { defineRule } from "@oxlint/plugins";

import {
  arbitraryProperty,
  arbitraryValue,
  visitClassesAndStyles,
} from "../tailwind.ts";

const CONTINUOUS_UTILITIES = new Set([
  "animate-spin",
  "animate-ping",
  "animate-pulse",
  "animate-bounce",
  "animate-caret-blink",
  "repeat-infinite",
]);
const INFINITE_PATTERN = /(?:^|[\s,])infinite(?:$|[\s,])/iu;

const repeatsForever = (name: string, value: string): boolean =>
  (name === "animation" || name === "animation-iteration-count") &&
  INFINITE_PATTERN.test(value);

const isContinuous = (utility: string): boolean => {
  if (CONTINUOUS_UTILITIES.has(utility)) return true;
  const value =
    arbitraryValue(utility, "animate-") ?? arbitraryValue(utility, "repeat-");
  if (value !== undefined) return INFINITE_PATTERN.test(value);
  const property = arbitraryProperty(utility);
  return (
    property !== undefined && repeatsForever(property.name, property.value)
  );
};

const message = (what: string): string =>
  `Show a still state instead of \`${what}\`, which repaints every frame for as long as it is on screen; if it must keep moving, say why with \`// oxlint-disable-next-line broods/no-continuous-animation -- <reason>\`.`;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow animations that repeat forever, in class strings and inline styles.",
    },
  },
  create: (context) =>
    visitClassesAndStyles(context, {
      matchesClass: isContinuous,
      matchesDeclaration: repeatsForever,
      message: message,
    }),
});
