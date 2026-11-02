// Prints what promptSecret read from this process's stdin, for cli-prompt-secret.test.ts.
import { promptSecret } from "../../src/cli/utils.ts";

console.log(`value=${JSON.stringify(await promptSecret("SECRET"))}`);
