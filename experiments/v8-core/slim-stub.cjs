/**
 * What SLIM=1 builds put in place of a package the task should never touch:
 * any property read gives back another stub, and calling or constructing one
 * throws, naming the package, so a task that needed it fails loudly. The
 * bundler copies a CommonJS module's own keys into the namespace it hands to
 * `import { x }` and keeps its prototype, so names are answered there too.
 *
 * Core builds some channel helpers when its modules load (twilio-channel.ts:
 * `new TwilioFormatConverter()`), so while the isolate is loading a call
 * gives back another stub; once entry.ts serves its first request
 * (`__slimServing`), any call throws.
 */
module.exports = function stubFor(name) {
  const fail = () => {
    if (!globalThis.__slimServing) return proxy;
    throw new Error(`slim build: ${name} was stubbed out but the task used it`);
  };
  const read = (_target, key) => {
    if (key === "__esModule") return false;
    if (key === Symbol.toPrimitive) return () => `[slim stub ${name}]`;
    if (key === "then") return undefined;
    return proxy;
  };
  const names = new Proxy({}, { get: read });
  const proxy = new Proxy(function slimStub() {}, {
    get: read,
    getPrototypeOf: () => names,
    apply: fail,
    construct: fail,
  });
  return proxy;
};
