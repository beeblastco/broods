import posthog, { type CaptureResult } from "posthog-js";

// Browser analytics and error tracking: anonymous behaviour only. No person
// profiles or identity, nothing users type or see (element text and
// attributes, replays), no ad ids from URLs, no GeoIP location, and
// exceptions keep their type and stack but not their message. A no-op when
// the key or host is unset, same contract as the OTLP exporters.
const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

// The part of a captured exception that can quote user input; posthog-js does
// not export a type for its `$exception_list` entries.
interface CapturedException {
  type?: string;
  value?: string;
}

if (posthogKey && posthogHost) {
  posthog.init(posthogKey, {
    api_host: posthogHost,
    before_send: anonymized,
    disable_session_recording: true,
    mask_all_element_attributes: true,
    mask_all_text: true,
    mask_personal_data_properties: true,
    person_profiles: "never",
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
  });
}

// Runs on every event, so it holds after posthog.reset() clears registered
// properties: no GeoIP lookup, and each exception message is replaced with
// its type so error tracking still groups by type and stack frames.
function anonymized(capture: CaptureResult | null): CaptureResult | null {
  if (!capture) return capture;
  capture.properties.$geoip_disable = true;
  if (capture.event === "$exception") {
    const exceptions: CapturedException[] =
      capture.properties.$exception_list ?? [];
    capture.properties.$exception_list = exceptions.map((exception) => ({
      ...exception,
      value: exception.type ?? "Error",
    }));
  }

  return capture;
}
