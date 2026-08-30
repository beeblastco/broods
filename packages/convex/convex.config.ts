/**
 * Convex app configuration for component integrations.
 */

import crons from "@convex-dev/crons/convex.config";
import stripe from "@convex-dev/stripe/convex.config.js";
import workOSAuthKit from "@convex-dev/workos-authkit/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(workOSAuthKit);
app.use(stripe);
app.use(crons);

export default app;
