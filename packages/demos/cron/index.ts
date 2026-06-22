/**
 * Prints the synced cron job status and recent run results.
 *
 * Cron jobs are declared in broods/agents.ts and synced by `bun run dev`.
 */

import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";


const client = new BroodsClient();

const runs = await client.listCronRuns(api.crons.oneMinuteCron, { limit: 10 });

console.log(JSON.stringify(runs, null, 2));
