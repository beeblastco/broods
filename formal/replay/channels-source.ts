import { suite } from "./suites/channels.ts";

// Load a private function verbatim with only its imported dependencies supplied by the replay.
export async function sourceFunctions<T>(
  path: string,
  names: string[],
  dependencies: Record<string, unknown>,
): Promise<T> {
  let source = await Bun.file(`${import.meta.dir}/../../${path}`).text();
  const mutation =
    process.env.CHANNELS_FAULT ||
    (process.env.SPEC_SUITE === "channels"
      ? process.env.SPEC_MUTATION
      : undefined);
  if (mutation !== undefined && mutation !== "") {
    const fault = suite.mutations[Number(mutation)];
    if (fault?.file === path) {
      if (!source.includes(fault.find))
        throw new Error("fault no longer matches");
      source = source.replace(fault.find, fault.replace);
    }
  }
  const functions = names
    .map((name): string => {
      const start = source.search(
        new RegExp(`(?:export )?(?:async )?function ${name}\\(`),
      );
      if (start < 0) throw new Error(`function missing: ${name}`);
      const end = source.indexOf("\n}", start);

      return source.slice(start, end + 2).replace(/^export /, "");
    })
    .join("\n");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(functions);

  const entries = Object.entries(dependencies).filter(
    ([key]): boolean => key !== "default",
  );

  // oxlint-disable-next-line typescript/no-implied-eval -- evaluates code taken from the real source on purpose
  return new Function(
    ...entries.map(([key]): string => key),
    `${js}; return {${names.join(",")}}`,
  )(...entries.map(([, value]): unknown => value)) as T;
}
