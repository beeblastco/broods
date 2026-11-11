import { plugin } from "bun";
import { suite } from "./suites/access.ts";

const index = process.env.SPEC_MUTATION;
const mutation = index ? suite.mutations[Number(index)] : undefined;
if (mutation) {
  plugin({
    name: "access-mutation",
    setup: function (build): void {
      build.onLoad(
        { filter: new RegExp(mutation.file.replaceAll(".", "\\.") + "$") },
        async (args) => {
          if (!args.path.endsWith(`/${mutation.file}`)) return undefined;
          const source = await Bun.file(args.path).text();
          if (!source.includes(mutation.find))
            throw new Error(`fault no longer matches: ${mutation.name}`);

          return {
            contents: source.replace(mutation.find, mutation.replace),
            loader: "ts",
          };
        },
      );
    },
  });
}
