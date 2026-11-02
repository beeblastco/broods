import { positiveIntegerEnv, requireEnv } from "../../core/src/shared/env.ts";
import {
  configPlanesEnv,
  type ConfigPlane,
} from "../../discord-forwarder/src/config.ts";

interface ForwarderConfig {
  planes: ConfigPlane[];
  port: number;
  // Required: a store on ephemeral disk would lose the device's keys on restart.
  storeDir: string;
}

export function forwarderConfigFromEnv(): ForwarderConfig {
  return {
    planes: configPlanesEnv(),
    port: positiveIntegerEnv("PORT", 3000),
    storeDir: requireEnv("MATRIX_STORE_DIR"),
  };
}
