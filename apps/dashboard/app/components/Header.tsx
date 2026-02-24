import Image from "next/image";
import logo from "../logo.png";

export function Header() {
  return (
    <header className="flex shrink-0 items-center gap-4 border-b border-white/10 px-6 py-5">
      <Image src={logo} alt="Logo" width={120} height={120} className="h-7 w-auto rounded-full" />
      <div className="h-6 w-px bg-white/10" />
      <span className="text-base font-medium text-white/70">My Workspace</span>
    </header>
  );
}
