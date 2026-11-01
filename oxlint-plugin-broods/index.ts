import { definePlugin } from "@oxlint/plugins";

import noAdHocTypeGuards from "./rules/no-ad-hoc-type-guards.ts";
import noBackdropBlur from "./rules/no-backdrop-blur.ts";
import noContinuousAnimation from "./rules/no-continuous-animation.ts";
import noFocusedTests from "./rules/no-focused-tests.ts";
import noHooklessUseFunction from "./rules/no-hookless-use-function.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noLayoutTransition from "./rules/no-layout-transition.ts";
import noLowValueComments from "./rules/no-low-value-comments.ts";
import noRawResizeObserver from "./rules/no-raw-resize-observer.ts";
import noTestInLoop from "./rules/no-test-in-loop.ts";
import noUnreasonedStateSync from "./rules/no-unreasoned-state-sync.ts";
import noUnscopedHas from "./rules/no-unscoped-has.ts";
import requireSkipReason from "./rules/require-skip-reason.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: { name: "broods" },
  rules: {
    "no-ad-hoc-type-guards": noAdHocTypeGuards,
    "no-backdrop-blur": noBackdropBlur,
    "no-continuous-animation": noContinuousAnimation,
    "no-focused-tests": noFocusedTests,
    "no-hookless-use-function": noHooklessUseFunction,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-layout-transition": noLayoutTransition,
    "no-low-value-comments": noLowValueComments,
    "no-raw-resize-observer": noRawResizeObserver,
    "no-test-in-loop": noTestInLoop,
    "no-unreasoned-state-sync": noUnreasonedStateSync,
    "no-unscoped-has": noUnscopedHas,
    "require-skip-reason": requireSkipReason,
    "require-suppression-reason": requireSuppressionReason,
  },
});
