/**
 * Prints the recent run results of a synced cron job.
 *
 * Cron jobs are declared in broods/agents.ts and synced by `bun run dev`.
 * Their run history lives on the config plane, so this needs
 * BROODS_ACCOUNT_SECRET, not a stage runtime key.
 */

import { BroodsAccountClient } from "broods/account";
import { api } from "./broods/_generated/api";

const account = new BroodsAccountClient();

const runs = await account.listCronRuns(api.crons.oneMinuteCron, { limit: 10 });

console.log(JSON.stringify(runs, null, 2));
