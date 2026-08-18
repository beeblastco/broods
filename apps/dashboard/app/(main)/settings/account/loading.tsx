/** Skeleton shown while the account settings page chunk and data load. */
import { SidebarPageSkeleton } from "@/app/components/SidebarPageSkeleton";

export default function AccountSettingsLoading(): React.JSX.Element {
  return <SidebarPageSkeleton title="Account" tabCount={2} />;
}
