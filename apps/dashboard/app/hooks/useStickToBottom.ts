import { useEffect, useRef, type RefObject } from "react";

// Scrolls the node to its end when any of `content` changes and `follow` says so. Instant,
// not smooth: a smooth scroll restarted per streamed chunk never settles.
export function useStickToBottom<T extends HTMLElement>(
  content: ReadonlyArray<unknown>,
  follow: () => boolean = alwaysFollow,
): RefObject<T | null> {
  const ref = useRef<T>(null);
  const last = useRef<ReadonlyArray<unknown>>([]);
  const lastNode = useRef<T | null>(null);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- scrolls the DOM node to its end
  useEffect(() => {
    const node = ref.current;
    // A node that just mounted counts as a change; content is seen only while one is there.
    const changed =
      node !== lastNode.current ||
      content.length !== last.current.length ||
      content.some((item, index) => !Object.is(item, last.current[index]));
    lastNode.current = node;
    if (!node) return;
    last.current = content;
    if (changed && follow()) node.scrollTop = node.scrollHeight;
  });

  return ref;
}

function alwaysFollow(): boolean {
  return true;
}
