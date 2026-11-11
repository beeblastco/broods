import { plugin } from "bun";
import { suite } from "./suites/hosted.ts";

const raw = process.env.SPEC_MUTATION;
const mutation = raw ? suite.mutations[Number(raw)] : undefined;
if (mutation) {
  const fullPath = `${import.meta.dir}/../../${mutation.file}`;
  plugin({
    name: "hosted-exact-source-fault",
    setup: function (build): void {
      build.onLoad(
        { filter: new RegExp(`${mutation.file.replaceAll(".", "\\.")}$`) },
        async (args) => {
          if (args.path !== fullPath.replaceAll("/formal/replay/../..", ""))
            return;
          const source = await Bun.file(args.path).text();
          if (!source.includes(mutation.find))
            throw new Error("fault no longer matches");

          return {
            contents: source.replace(mutation.find, mutation.replace),
            loader: "ts",
          };
        },
      );
    },
  });
}
