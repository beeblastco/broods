/**
 * Environment for the Matrix forwarder. The config-plane list and its deploy
 * keys are the ones `apps/discord-forwarder` reads, so that module parses them.
 */

import { positiveIntegerEnv, requireEnv } from "../../core/src/shared/env.ts";
import {
  configPlanesEnv,
  type ConfigPlane,
} from "../../discord-forwarder/src/config.ts";

interface ForwarderConfig {
  /** Every config plane this process serves. One process, not one per stage. */
  planes: ConfigPlane[];
  port: number;
  /**
   * Root of every account's crypto store and sync token. Required, not defaulted:
   * a store that silently lands on ephemeral disk loses its keys on restart.
   */
  storeDir: string;
}

export function forwarderConfigFromEnv(): ForwarderConfig {
  return {
    planes: configPlanesEnv(),
    port: positiveIntegerEnv("PORT", 3000),
    storeDir: requireEnv("MATRIX_STORE_DIR"),
  };
}
