/**
 * SLIM=1 stand-in for a package: every property read gives another stub. Calls give stubs while
 * modules load (core constructs some helpers then); once entry.ts sets `__slimServing`, they throw.
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
