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
    const mount = (): void => {
      init.textContent = `window.Scalar.createApiReference(document.getElementById(${JSON.stringify(id)}), ${route.configuration})`;
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
        document.body.appendChild(bundle);
      }
      bundle.addEventListener("load", mount, { once: true });
    }

    return () => {
      bundle?.removeEventListener("load", mount);
      init.remove();
    };
  }, [id, route.configuration]);

  return (
    <Layout>
      <div id={id} />
    </Layout>
  );
}
