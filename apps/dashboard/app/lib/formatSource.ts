/**
 * Prettier over tool source code. It lives apart from the CodeMirror editor so
 * the Save/Format buttons can reach it without pulling the editor bundle into
 * every side-panel load. Throws on a syntax error, so callers report it.
 */
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
