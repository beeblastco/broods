import { useEffect, useRef, type RefObject } from "react";

// Scrolls the node to its end when any of `content` changes and `follow` says so. Instant,
// not smooth: a smooth scroll restarted per streamed chunk never settles.
export function useStickToBottom<T extends HTMLElement>(
  content: ReadonlyArray<unknown>,
  follow: () => boolean = alwaysFollow,
): RefObject<T | null> {
  const ref = useRef<T>(null);
  const last = useRef<ReadonlyArray<unknown>>([]);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- scrolls the DOM node to its end
  useEffect(() => {
    const changed =
      content.length !== last.current.length ||
      content.some((item, index) => !Object.is(item, last.current[index]));
    last.current = content;
    const node = ref.current;
    if (changed && node && follow()) node.scrollTop = node.scrollHeight;
  });

  return ref;
}

function alwaysFollow(): boolean {
  return true;
}
