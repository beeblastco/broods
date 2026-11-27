// The one-time account key stays in memory only: it must never reach browser storage.
const EVENT_NAME = "fp:onboarding-secret";
let pendingSecret: string | null = null;

export function publishOnboardingSecret(secret: string): void {
  if (typeof window === "undefined") return;

  pendingSecret = secret;
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function readOnboardingSecret(): string | null {
  if (typeof window === "undefined") return null;

  return pendingSecret;
}

export function clearOnboardingSecret(): void {
  if (typeof window === "undefined") return;

  pendingSecret = null;
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function subscribeOnboardingSecret(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  window.addEventListener(EVENT_NAME, listener);

  return () => window.removeEventListener(EVENT_NAME, listener);
}
