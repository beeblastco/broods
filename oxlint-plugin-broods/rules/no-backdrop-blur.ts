import { defineRule } from "@oxlint/plugins";

import { arbitraryProperty, visitClassesAndStyles } from "../tailwind.ts";

const BLUR_UTILITY_PATTERN = /^backdrop-blur(?:-(?!none$).+)?$/u;
const BACKDROP_FILTERS = new Set([
  "backdrop-filter",
  "-webkit-backdrop-filter",
]);

const blursBackdrop = (name: string, value: string): boolean =>
  BACKDROP_FILTERS.has(name) && /blur\(/iu.test(value);

const isBackdropBlur = (utility: string): boolean => {
  if (BLUR_UTILITY_PATTERN.test(utility)) return true;
  const property = arbitraryProperty(utility);
  return property !== undefined && blursBackdrop(property.name, property.value);
};

const message = (what: string): string =>
  `Use an opaque surface token such as bg-popover, bg-card or bg-background instead of \`${what}\`: a backdrop blur re-rasterizes whatever moves beneath it on every frame.`;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow backdrop blur, in class strings and inline styles.",
    },
  },
  create: (context) =>
    visitClassesAndStyles(context, {
      matchesClass: isBackdropBlur,
      matchesDeclaration: blursBackdrop,
      message: message,
    }),
});
