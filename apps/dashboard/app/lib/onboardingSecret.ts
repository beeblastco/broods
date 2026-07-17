/**
 * Cross-route handoff for a freshly-provisioned one-time account secret. The
 * publisher (home bootstrap or org switcher) stores the plaintext briefly so
 * the onboarding dialog rendered in the persistent main layout can surface it
 * after the publishing route navigates away. The secret is cleared once the
 * flow completes.
 */

const STORAGE_KEY = "fp:onboarding-secret";
const EVENT_NAME = "fp:onboarding-secret";

/**
 * Publishes a one-time secret so the onboarding dialog can show it on the next
 * (or current) route, then notifies any mounted listener.
 * @param secret the plaintext fp_acct_ secret to surface once
 */
export function publishOnboardingSecret(secret: string) {
  if (typeof window === "undefined") return;

  window.sessionStorage.setItem(STORAGE_KEY, secret);
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

/**
 * Reads the currently pending one-time secret, or null when none is queued.
 * @returns the pending plaintext secret, or null
 */
export function readOnboardingSecret(): string | null {
  if (typeof window === "undefined") return null;

  return window.sessionStorage.getItem(STORAGE_KEY);
}

/** Clears the pending one-time secret and notifies listeners. */
export function clearOnboardingSecret() {
  if (typeof window === "undefined") return;

  window.sessionStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

/**
 * Subscribes to onboarding-secret changes (publish or clear).
 * @param listener invoked whenever the pending secret changes
 * @returns an unsubscribe function
 */
export function subscribeOnboardingSecret(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  window.addEventListener(EVENT_NAME, listener);

  return () => window.removeEventListener(EVENT_NAME, listener);
}
