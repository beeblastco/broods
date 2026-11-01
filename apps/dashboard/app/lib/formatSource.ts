// Apart from the editor, so Save/Format never pull its bundle into a side-panel load.
export async function formatSource(source: string): Promise<string> {
  const [standalone, babel, estree] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/babel"),
    import("prettier/plugins/estree"),
  ]);

  return await standalone.format(source, {
    parser: "babel",
    plugins: [babel.default, estree.default],
  });
}
