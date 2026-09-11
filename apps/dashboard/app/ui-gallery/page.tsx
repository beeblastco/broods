/**
 * Component fixture for the browser tests in e2e/ui. Renders the pieces
 * that broke in the wild (select popup, onboarding card, canvas controls,
 * save pill) with no Convex or auth behind them, so Playwright can measure
 * their real layout. Dev only: the proxy lets it through unauthenticated
 * there, and here it is a 404 everywhere else.
 */
import { notFound } from "next/navigation";
import { UiGallery } from "./UiGallery";

export default function UiGalleryPage(): React.JSX.Element {
  if (process.env.NODE_ENV !== "development") notFound();

  return <UiGallery />;
}
