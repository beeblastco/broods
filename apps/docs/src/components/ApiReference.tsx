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
    // The configuration is a JavaScript literal (it can hold functions), so it runs as a script.
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
