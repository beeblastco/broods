/**
 * Prints the synced cron job status and recent run results.
 *
 * Cron jobs are declared in filthypanty/agents.ts and synced by `bun run dev`.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";


const client = new FilthyPantyClient();

const runs = await client.listCronRuns(api.crons.oneMinuteCron, { limit: 10 });

console.log(JSON.stringify(runs, null, 2));
