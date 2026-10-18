// `wrangler.jsonc` rules and Bun both load a `.txt` import as its text.
declare module "*.txt" {
  const text: string;
  export default text;
}
