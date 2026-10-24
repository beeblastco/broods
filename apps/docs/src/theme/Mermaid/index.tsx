/**
 * Renders the docs' Mermaid blocks with Pele and adapts them to the page width.
 */

import { mount } from "pele";
import { useEffect, useRef, type ReactNode } from "react";
import styles from "./styles.module.css";

interface Props {
  value: string;
}

/** Docusaurus passes each Mermaid fence's source through the value prop. */
export default function Mermaid({ value }: Props): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect((): (() => void) | undefined => {
    const container = containerRef.current;
    if (!container) return;

    const diagram = mount(container, value, { images: false, links: false });

    return (): void => {
      diagram.destroy();
    };
  }, [value]);

  return <div ref={containerRef} className={styles.container} />;
}
