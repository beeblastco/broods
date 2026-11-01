import { promptSecret } from "../../src/cli/utils.ts";

console.log(`value=${JSON.stringify(await promptSecret("SECRET"))}`);
