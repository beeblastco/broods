import { ShortcutProvider } from "@/app/components/ShortcutProvider";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { UiGallery } from "./UiGallery";

export default function UiGalleryPage(): React.JSX.Element {
  if (process.env.NODE_ENV !== "development") notFound();

  // UiGallery reads ?tab=, and a search-param read needs its own Suspense boundary.
  return (
    <ShortcutProvider>
      <Suspense>
        <UiGallery />
      </Suspense>
    </ShortcutProvider>
  );
}
