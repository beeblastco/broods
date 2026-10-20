import posthog from "posthog-js";

// Browser analytics and error tracking: behaviour only, never what users type
// or see, so no element text or attributes, no replays, no ad ids from URLs. A
// no-op when the key or host is unset, same contract as the OTLP exporters.
const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if (posthogKey && posthogHost) {
  posthog.init(posthogKey, {
    api_host: posthogHost,
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
}
