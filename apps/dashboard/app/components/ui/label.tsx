"use client";

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/app/lib/utils";

const labelVariants = cva(
  "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "",
        muted: "text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Label({
  className,
  variant,
  ...props
}: React.ComponentProps<"label"> & VariantProps<typeof labelVariants>) {
  return (
    <label
      data-slot="label"
      className={cn(labelVariants({ variant: variant }), className)}
      {...props}
    />
  );
}

export { Label };
