import {
  connectionRefusal,
  type ConnectionGraph,
} from "@/app/lib/canvasConnections";
import {
  useConnection,
  type Connection,
  type OnConnectEnd,
} from "@xyflow/react";
import { useCallback, useMemo, useState } from "react";

export type ShownRefusal = {
  message: string;
  nodeId: string;
  dropped: boolean;
};

/** Why the line being drawn is refused; a refused drop keeps its reason until `clear`. */
export function useConnectionRefusal(getGraph: () => ConnectionGraph): {
  clear: () => void;
  onConnectEnd: OnConnectEnd;
  refusal: ShownRefusal | null;
} {
  // React Flow only validates connectable handles, so this asks about any aimed handle. A
  // card's own handles are skipped, or every drag would open on "can't connect to itself".
  const aimed = useConnection((connection): Connection | null =>
    connection.inProgress &&
    connection.toNode &&
    connection.toHandle &&
    connection.toNode.id !== connection.fromNode.id
      ? {
          source: connection.fromNode.id,
          sourceHandle: connection.fromHandle.id ?? null,
          target: connection.toNode.id,
          targetHandle: connection.toHandle.id ?? null,
        }
      : null,
  );
  const [dropped, setDropped] = useState<ShownRefusal | null>(null);
  const refusal = useMemo((): ShownRefusal | null => {
    const message = aimed ? connectionRefusal(getGraph(), aimed) : null;

    return aimed && message
      ? { dropped: false, message: message, nodeId: aimed.target }
      : dropped;
  }, [aimed, dropped, getGraph]);

  const clear = useCallback((): void => setDropped(null), []);
  const onConnectEnd: OnConnectEnd = useCallback(
    (_event, connection): void => {
      const source = connection.fromNode;
      const target = connection.toNode;
      if (connection.isValid || !source || !target || source.id === target.id) {
        setDropped(null);

        return;
      }
      const message = connectionRefusal(getGraph(), {
        source: source.id,
        sourceHandle: connection.fromHandle?.id ?? null,
        target: target.id,
        targetHandle: connection.toHandle?.id ?? null,
      });
      setDropped(
        message ? { dropped: true, message: message, nodeId: target.id } : null,
      );
    },
    [getGraph],
  );

  return { clear: clear, onConnectEnd: onConnectEnd, refusal: refusal };
}
