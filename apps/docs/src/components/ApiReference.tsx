/**
 * The API reference page. Scalar's own route component expects its standalone
 * bundle already on `window`, which its plugin gets by putting a render-blocking
 * 1 MB script on every docs page. This one loads the bundle here only.
 */
import "@scalar/docusaurus/dist/theme.css";
import Layout from "@theme/Layout";
import { useEffect, useId } from "react";

// Pinned: the plugin's default is the CDN's moving `latest`.
export const SCALAR_BUNDLE =
  "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.4/dist/browser/standalone.js";
const UNMOUNT_EVENT = "api-reference:unmount";

export default function ApiReference({
  route,
}: {
  route: { configuration: string };
}): React.JSX.Element {
  const id = useId();

  useEffect(() => {
    // The configuration arrives serialized as a JavaScript literal (it can
    // hold functions), so it runs as a script, as Scalar's component does.
    const init = document.createElement("script");
    const element = document.getElementById(id);
    const mount = (): void => {
      init.textContent = `{ const element = document.getElementById(${JSON.stringify(id)}); element.addEventListener("${UNMOUNT_EVENT}", window.Scalar.createApiReference(element, ${route.configuration}).destroy, { once: true }); }`;
      document.body.appendChild(init);
    };
    let bundle = document.querySelector<HTMLScriptElement>(
      `script[src="${SCALAR_BUNDLE}"]`,
    );
    if (bundle?.dataset.loaded) {
      mount();
    } else {
      if (!bundle) {
        bundle = document.createElement("script");
        bundle.src = SCALAR_BUNDLE;
        bundle.addEventListener("load", () => {
          if (bundle) bundle.dataset.loaded = "true";
        });
        // A failed bundle never fires `load`: drop it so the next visit retries.
        bundle.addEventListener("error", () => bundle?.remove(), {
          once: true,
        });
        document.body.appendChild(bundle);
      }
      bundle.addEventListener("load", mount, { once: true });
    }

    return () => {
      bundle?.removeEventListener("load", mount);
      init.remove();
      element?.dispatchEvent(new Event(UNMOUNT_EVENT));
    };
  }, [id, route.configuration]);

  return (
    <Layout>
      <div id={id} />
    </Layout>
  );
}
