/// <reference types="next" />
/// <reference types="next/image-types/global" />

// CSS Module declarations
declare module "*.css" {
  const content: Record<string, string>;
  export default content;
}

declare module "*.scss" {
  const content: Record<string, string>;
  export default content;
}

declare module "*.sass" {
  const content: Record<string, string>;
  export default content;
}

declare module "react-file-icon" {
  import type { ComponentType, SVGProps } from "react";
  export interface StyleProps {
    type?: string;
    color?: string;
    gradientColor?: string;
    gradientOpacity?: number;
    fold?: boolean;
    foldColor?: string;
    glyphColor?: string;
    labelColor?: string;
    labelTextColor?: string;
    labelUppercase?: boolean;
    radius?: number;
    [key: string]: unknown;
  }
  export const defaultStyles: Record<string, StyleProps>;
  export const FileIcon: ComponentType<
    SVGProps<SVGSVGElement> & { extension?: string } & StyleProps
  >;
}
