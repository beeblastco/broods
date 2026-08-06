"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/app/lib/utils";

interface SwitchProps extends Omit<SwitchPrimitive.Root.Props, "className"> {
  className?: string;
}

function Switch({ className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer data-checked:bg-primary data-unchecked:bg-input focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-[1.15rem] w-8 shrink-0 cursor-pointer items-center rounded-sm border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "bg-background pointer-events-none block size-4 rounded-sm ring-0 transition-transform data-checked:translate-x-[calc(100%-2px)] data-unchecked:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
