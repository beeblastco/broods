/** Skeleton shown while the settings page chunk and data load. */
import { SidebarPageSkeleton } from "@/app/components/SidebarPageSkeleton";

export default function SettingsLoading(): React.JSX.Element {
  return <SidebarPageSkeleton title="Settings" tabCount={5} />;
}
