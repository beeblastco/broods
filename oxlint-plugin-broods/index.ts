import { definePlugin } from "@oxlint/plugins";

import noLowValueComments from "./rules/no-low-value-comments.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: { name: "broods" },
  rules: {
    "no-low-value-comments": noLowValueComments,
    "require-suppression-reason": requireSuppressionReason,
  },
});
