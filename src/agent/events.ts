import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

export interface TurnResult {
  text: string;
  toolCalls: string[];
  error?: string;
}

/**
 * Subscribe to session events and track assistant turns.
 * Calls onTurnComplete when a new text response starts (flushing the previous)
 * or when the message ends.
 */
export function createTurnTracker(
  session: AgentSession,
  onTurnComplete?: (turn: TurnResult) => void
): { unsubscribe: () => void; getCurrentText: () => string } {
  let currentText = "";
  let toolCalls: string[] = [];

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_start") {
          if (onTurnComplete && currentText.length > 0) {
            onTurnComplete({ text: currentText, toolCalls });
          }
          currentText = "";
          toolCalls = [];
        }
        if (event.assistantMessageEvent.type === "text_delta") {
          currentText += event.assistantMessageEvent.delta;
        }
        break;
      case "message_end": {
        const msg = event.message as unknown as Record<string, unknown>;
        const errorMessage = msg?.errorMessage as string | undefined;
        if (onTurnComplete && (currentText.length > 0 || errorMessage)) {
          onTurnComplete({ text: currentText, toolCalls, error: errorMessage });
        }
        currentText = "";
        toolCalls = [];
        break;
      }
      case "tool_execution_start":
        toolCalls.push(event.toolName ?? "unknown");
        break;
    }
  });

  return { unsubscribe, getCurrentText: () => currentText };
}

/**
 * Wait until a session is idle (not streaming, compacting, or retrying).
 * Polls every 50ms and requires 10 consecutive idle ticks before returning.
 */
export async function waitForIdle(
  session: AgentSession,
  timeoutMs: number = 120_000
): Promise<void> {
  const start = Date.now();
  let idleTicks = 0;

  while (idleTicks < 10) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Session did not become idle within ${timeoutMs}ms`);
    }
    if (!session.isStreaming && !session.isCompacting && !session.isRetrying) {
      idleTicks++;
    } else {
      idleTicks = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
