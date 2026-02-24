"use client";

import { Canvas } from "@/app/components/canvas/Canvas";
import { Header } from "@/app/components/Header";

export default function Home() {
    return (
        <div className="flex h-screen w-screen flex-col bg-[#0a0a0a]">
            <Header />

            <div className="flex-1">
                <Canvas />
            </div>
        </div>
    );
}
