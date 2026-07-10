import { dts } from "rollup-plugin-dts";

export default [
  {
    input: "src/index.ts",
    output: {
      file: "dist/index.d.ts",
      format: "es",
    },
    plugins: [dts({ tsconfig: "./tsconfig.dts.json" })],
  },
  {
    input: "src/account.ts",
    output: {
      file: "dist/account.d.ts",
      format: "es",
    },
    plugins: [dts({ tsconfig: "./tsconfig.dts.json" })],
  },
];
