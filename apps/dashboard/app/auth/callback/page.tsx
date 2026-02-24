"use client";

import { useShooAuth } from "@shoojs/react";

/** Handles the Shoo OAuth callback redirect. */
export default function ShooCallback() {
    useShooAuth();

    return <p>Signing in...</p>;
}
