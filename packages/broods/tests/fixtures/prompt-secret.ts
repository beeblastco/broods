// Prints what promptSecret read from this process's stdin, for cli-prompt-secret.test.ts.
import { promptSecret } from "../../src/cli/utils.ts";

const optional = process.argv.includes("--optional");
console.log(
  `value=${JSON.stringify(await promptSecret("SECRET", { optional: optional }))}`,
);
