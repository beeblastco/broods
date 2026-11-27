import type { Suite } from "../suite.ts";
import { suite as workers } from "./workers.ts";
import { suite as access } from "./access.ts";
import { suite as runs } from "./runs.ts";
import { suite as agent } from "./agent.ts";
import { suite as sandbox } from "./sandbox.ts";
import { suite as channels } from "./channels.ts";
import { suite as hosted } from "./hosted.ts";
import { suite as config } from "./config.ts";

export const SUITES: readonly Suite[] = [
  workers,
  access,
  runs,
  agent,
  sandbox,
  channels,
  hosted,
  config,
];
