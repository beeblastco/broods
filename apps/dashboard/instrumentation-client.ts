import { analytics } from "@/app/lib/analytics";
import type { CaptureResult, Properties } from "posthog-js";

// Browser analytics and error tracking: anonymous behaviour only, never what
// users type or see. A no-op when the key or host is unset.
const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
// Behind a reverse proxy posthog-js cannot derive the app's URL from the host.
const posthogUiHost = process.env.NEXT_PUBLIC_POSTHOG_UI_HOST;

// URL properties keep only these opaque params; search boxes write what users
// type into the URL (`?q=`), so every other param is dropped.
const URL_PARAMS_KEPT = new Set(["node", "stage", "tab"]);
const URL_PROPERTIES = [
  "$current_url",
  "$initial_current_url",
  "$initial_referrer",
  "$referrer",
];

// The part of a captured exception that can quote user input; posthog-js does
// not export a type for its `$exception_list` entries.
interface CapturedException {
  type?: string;
  value?: string;
}

void analytics.then((posthog): void => {
  if (!posthogKey || !posthogHost) return;

  posthog.init(posthogKey, {
    api_host: posthogHost,
    before_send: anonymized,
    disable_session_recording: true,
    mask_all_element_attributes: true,
    mask_all_text: true,
    mask_personal_data_properties: true,
    person_profiles: "identified_only",
    ui_host: posthogUiHost,
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
  });
  // Browsers identified before analytics went anonymous still hold the email
  // and name the flags request would send.
  posthog.resetPersonPropertiesForFlags();
});

// Runs on every event, so it holds after posthog.reset() clears registered
// properties: no GeoIP lookup, URLs without typed params, and each exception
// message replaced with its type so error tracking still groups by type and
// stack frames.
function anonymized(capture: CaptureResult | null): CaptureResult | null {
  if (!capture) return capture;
  capture.properties.$geoip_disable = true;
  for (const properties of [
    capture.properties,
    capture.$set,
    capture.$set_once,
  ]) {
    if (properties) withKnownUrlParams(properties);
  }
  if (capture.event === "$exception") {
    const exceptions: CapturedException[] =
      capture.properties.$exception_list ?? [];
    capture.properties.$exception_list = exceptions.map(
      (exception): CapturedException => ({
        ...exception,
        value: exception.type ?? "Error",
      }),
    );
  }

  return capture;
}

function withKnownUrlParams(properties: Properties): void {
  for (const key of URL_PROPERTIES) {
    const url: unknown = properties[key];
    if (typeof url !== "string" || !URL.canParse(url)) continue;
    const parsed = new URL(url);
    parsed.search = new URLSearchParams(
      Array.from(parsed.searchParams).filter(([name]): boolean =>
        URL_PARAMS_KEPT.has(name),
      ),
    ).toString();
    parsed.hash = "";
    properties[key] = parsed.toString();
  }
}
