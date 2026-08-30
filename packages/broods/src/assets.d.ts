// Text assets inlined by the bundler (`with { type: "text" }` imports).
declare module "*.md" {
  const text: string;
  export default text;
}

declare module "*.sh" {
  const text: string;
  export default text;
}
