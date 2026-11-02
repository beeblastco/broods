/** workerd's createRequire cannot load node:process; hand back the global. */
const nodeProcess = globalThis.process;
export = nodeProcess;
