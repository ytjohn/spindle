import type { ImageContent } from "@earendil-works/pi-ai";
import type { QueuedMessage } from "./types";

/**
 * FIFO queue of Telegram messages waiting to be dispatched to a session.
 *
 * Deliberately dumb: it knows nothing about busy/idle state or session
 * routing. The channel orchestrator decides when to call `dispatch()`.
 * This keeps the queue trivially testable and leaves room to add
 * per-session queues later without changing its logic.
 */
export class MessageQueue {
  private items: QueuedMessage[] = [];
  private byTelegramMessageId = new Map<number, QueuedMessage>();
  private nextSeq = 1;

  enqueue(
    text: string,
    telegramMessageId: number,
    senderId: number,
    images?: ImageContent[]
  ): QueuedMessage {
    const item: QueuedMessage = {
      seq: this.nextSeq++,
      telegramMessageId,
      senderId,
      text,
      ...(images && images.length > 0 ? { images } : {}),
      receivedAt: Date.now(),
      dispatched: false,
    };
    this.items.push(item);
    this.byTelegramMessageId.set(telegramMessageId, item);
    return item;
  }

  /**
   * Remove and return the oldest undispatched message, marking it dispatched.
   * Returns null if the queue has no undispatched items.
   */
  dispatch(): QueuedMessage | null {
    const index = this.items.findIndex((m) => !m.dispatched);
    if (index === -1) return null;
    const [item] = this.items.splice(index, 1);
    this.byTelegramMessageId.delete(item.telegramMessageId);
    item.dispatched = true;
    return item;
  }

  /**
   * Peek at the next undispatched message without removing it.
   */
  peek(): QueuedMessage | null {
    return this.items.find((m) => !m.dispatched) ?? null;
  }

  /**
   * Replace the text of an already-queued message that has not yet been
   * dispatched. Returns true if the message was found and updated, false
   * otherwise (already dispatched, or never queued).
   */
  tryEdit(telegramMessageId: number, newText: string): boolean {
    const item = this.byTelegramMessageId.get(telegramMessageId);
    if (!item || item.dispatched) return false;
    item.text = newText;
    return true;
  }

  /**
   * Count of undispatched messages remaining in the queue.
   */
  get length(): number {
    return this.items.filter((m) => !m.dispatched).length;
  }

  /**
   * Clear everything. Used on channel shutdown.
   */
  clear(): void {
    this.items = [];
    this.byTelegramMessageId.clear();
  }
}
