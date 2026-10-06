"use client";

import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import type { ErrorInfo } from "next/error";
import "./globals.css";

// Replaces the root layout, so no providers and no theme provider: pin the
// app's default dark theme on the document it renders itself.
export default function GlobalError({ error }: ErrorInfo): React.JSX.Element {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <title>Broods Dashboard</title>
        <StatusPage title="Broods hit an error" error={error}>
          <Button
            onClick={() => window.location.reload()}
            className="cursor-pointer"
          >
            Reload
          </Button>
        </StatusPage>
      </body>
    </html>
  );
}
