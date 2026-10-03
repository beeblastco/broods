"use client";

import { ConnectionsPanel } from "./components/ConnectionsPanel";

export default function ConnectionsPage(): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 flex-col overflow-auto">
      <h1 className="sr-only">Connections</h1>
      <div className="mx-auto w-full max-w-2xl px-6 pt-6 pb-12">
        <ConnectionsPanel />
      </div>
    </div>
  );
}
