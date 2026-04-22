/**
 * Generic utilities for harness-processing.
 * Keep small generic helpers here when they do not belong elsewhere.
 */

export function sseEvent(event: Record<string, unknown>): Uint8Array {
    return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export function emptyStream(): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.close();
        },
    });
}
