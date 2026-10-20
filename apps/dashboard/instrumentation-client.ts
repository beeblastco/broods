import posthog, { type CaptureResult } from "posthog-js";

// The part of a captured exception that can quote user input; posthog-js ships
// no type for its `$exception_list` entries.
interface CapturedException {
  type?: string;
  value?: string;
}

// Browser analytics and error tracking: behaviour only, never what users type
// or see, so no element text or attributes, no replays, no ad ids from URLs,
// no GeoIP location, and exceptions keep their type and stack but not their
// message. A no-op when the key or host is unset, same contract as the OTLP
// exporters.
const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if (posthogKey && posthogHost) {
  posthog.init(posthogKey, {
    api_host: posthogHost,
    before_send: withoutExceptionMessages,
    disable_session_recording: true,
    mask_all_element_attributes: true,
    mask_all_text: true,
    mask_personal_data_properties: true,
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
  });
  posthog.register({ $geoip_disable: true });
}

// Replaces each exception message with its type, so error tracking still
// groups by type and stack frames without carrying text a user typed.
function withoutExceptionMessages(
  capture: CaptureResult | null,
): CaptureResult | null {
  if (capture?.event !== "$exception") return capture;
  const exceptions: CapturedException[] =
    capture.properties.$exception_list ?? [];
  capture.properties.$exception_list = exceptions.map((exception) => ({
    ...exception,
    value: exception.type ?? "Error",
  }));

  return capture;
}
