// `wrangler.jsonc` rules and Bun both load a `.txt` import as its text.
declare module "*.txt" {
  const text: string;
  export default text;
}

// The two zlib calls the disk codec makes; workerd provides them under
// `nodejs_compat`, and the Worker types carry no Node declarations.
declare module "node:zlib" {
  export function gzipSync(data: Uint8Array): Uint8Array;
  export function gunzipSync(data: Uint8Array): Uint8Array;
}
