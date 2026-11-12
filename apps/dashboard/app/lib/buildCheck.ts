const CHECK_EVERY_MS = 60_000;

let checkedAt = 0;
let stale = false;

/** True once the server answered with another build than the one this tab runs. */
export function isStaleBuild(): boolean {
  return stale;
}

/** Asks the server which build it serves, at most once a minute and never in the way. */
export function checkBuild(): void {
  if (stale || Date.now() - checkedAt < CHECK_EVERY_MS) return;
  checkedAt = Date.now();
  void fetch("/healthz", { cache: "no-store" })
    .then((response): Promise<{ build?: string }> => response.json())
    .then((health): void => {
      stale =
        health.build !== undefined &&
        health.build !== process.env.DASHBOARD_BUILD_ID;
    })
    // Offline or mid-deploy: the next navigation asks again.
    .catch((): void => {});
}
