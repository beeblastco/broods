const CANVAS_ACTION_EVENT = "broods:canvas-action";

export type CanvasAction =
  | { kind: "connect"; source: string; target: string }
  | { agent?: string; kind: "addMcp"; name: string; url: string }
  | {
      agent: string;
      kind: "addNode";
      nodeType: "sandbox" | "skill" | "workspace";
    };

interface CanvasActionDetail {
  action: CanvasAction;
  done: (error?: string) => void;
  received: boolean;
}

// The dock asks the mounted canvas to edit its graph; it rejects with the canvas's reason.
export function requestCanvasAction(action: CanvasAction): Promise<void> {
  return new Promise((resolve, reject) => {
    const detail: CanvasActionDetail = {
      action: action,
      done: (error?: string): void => {
        if (error) reject(new Error(error));
        else resolve();
      },
      received: false,
    };
    // Dispatch runs listeners synchronously, so no answer here means no canvas is mounted.
    window.dispatchEvent(
      new CustomEvent(CANVAS_ACTION_EVENT, { detail: detail }),
    );
    if (!detail.received)
      reject(new Error("Open the Architecture canvas first."));
  });
}

export function onCanvasAction(
  handle: (action: CanvasAction) => Promise<string | undefined>,
): () => void {
  const answer = async (detail: CanvasActionDetail): Promise<void> => {
    let refusal: string | undefined;
    try {
      refusal = await handle(detail.action);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    detail.done(refusal);
  };
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<CanvasActionDetail>).detail;
    detail.received = true;
    void answer(detail);
  };
  window.addEventListener(CANVAS_ACTION_EVENT, listener);

  return () => window.removeEventListener(CANVAS_ACTION_EVENT, listener);
}
