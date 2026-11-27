import { readFileSync } from "node:fs";
import { plugin } from "bun";
import { SUITES } from "./suites/index.ts";

const suite = SUITES.find((entry) => entry.name === process.env.SPEC_SUITE);
const index = process.env.SPEC_MUTATION;
const mutation = index ? suite?.mutations[Number(index)] : undefined;

// With no index the run has no fault, so a no-fault baseline goes through this same code path.
if (mutation) {
  plugin({
    name: "spec-mutation",
    setup: function (build): void {
      // The whole path, since a name like principal.ts exists in more than one package.
      const filter = new RegExp(
        `/${mutation.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      );
      build.onLoad({ filter: filter }, (args) => {
        const source = readFileSync(args.path, "utf8");
        if (!source.includes(mutation.find)) {
          throw new Error(
            `mutation "${mutation.name}" no longer matches ${mutation.file}`,
          );
        }

        return {
          contents: source.replace(mutation.find, mutation.replace),
          loader: "ts",
        };
      });
    },
  });
}
