import { describe, it, expect } from "vitest";
import { MessageQueue } from "../../../src/channels/telegram/queue";

describe("MessageQueue", () => {
  it("enqueues with incrementing sequence numbers", () => {
    const q = new MessageQueue();
    const a = q.enqueue("first", 1, 100);
    const b = q.enqueue("second", 2, 100);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it("dispatches in FIFO order", () => {
    const q = new MessageQueue();
    q.enqueue("first", 1, 100);
    q.enqueue("second", 2, 100);
    q.enqueue("third", 3, 100);

    expect(q.dispatch()?.text).toBe("first");
    expect(q.dispatch()?.text).toBe("second");
    expect(q.dispatch()?.text).toBe("third");
  });

  it("dispatch returns null when queue is empty", () => {
    const q = new MessageQueue();
    expect(q.dispatch()).toBeNull();
  });

  it("peek shows next item without removing it", () => {
    const q = new MessageQueue();
    q.enqueue("hello", 1, 100);
    expect(q.peek()?.text).toBe("hello");
    expect(q.length).toBe(1);
    expect(q.dispatch()?.text).toBe("hello");
    expect(q.peek()).toBeNull();
  });

  it("length reflects undispatched items only", () => {
    const q = new MessageQueue();
    expect(q.length).toBe(0);
    q.enqueue("a", 1, 100);
    q.enqueue("b", 2, 100);
    expect(q.length).toBe(2);
    q.dispatch();
    expect(q.length).toBe(1);
    q.dispatch();
    expect(q.length).toBe(0);
  });

  it("marks dispatched items as dispatched", () => {
    const q = new MessageQueue();
    q.enqueue("hello", 1, 100);
    const item = q.dispatch();
    expect(item?.dispatched).toBe(true);
  });

  it("tryEdit updates text of undispatched item by telegram message ID", () => {
    const q = new MessageQueue();
    q.enqueue("original", 42, 100);
    const ok = q.tryEdit(42, "edited");
    expect(ok).toBe(true);
    expect(q.peek()?.text).toBe("edited");
  });

  it("tryEdit returns false for already-dispatched item", () => {
    const q = new MessageQueue();
    q.enqueue("original", 42, 100);
    q.dispatch();
    const ok = q.tryEdit(42, "too late");
    expect(ok).toBe(false);
  });

  it("tryEdit returns false for unknown message ID", () => {
    const q = new MessageQueue();
    const ok = q.tryEdit(999, "whatever");
    expect(ok).toBe(false);
  });

  it("clear empties the queue", () => {
    const q = new MessageQueue();
    q.enqueue("a", 1, 100);
    q.enqueue("b", 2, 100);
    q.clear();
    expect(q.length).toBe(0);
    expect(q.dispatch()).toBeNull();
  });

  it("mixed enqueue and dispatch maintains correct order", () => {
    const q = new MessageQueue();
    q.enqueue("a", 1, 100);
    q.enqueue("b", 2, 100);
    expect(q.dispatch()?.text).toBe("a");
    q.enqueue("c", 3, 100);
    expect(q.dispatch()?.text).toBe("b");
    expect(q.dispatch()?.text).toBe("c");
    expect(q.dispatch()).toBeNull();
  });

  it("tracks sender ID on each message", () => {
    const q = new MessageQueue();
    q.enqueue("from user A", 1, 100);
    q.enqueue("from user B", 2, 200);
    expect(q.dispatch()?.senderId).toBe(100);
    expect(q.dispatch()?.senderId).toBe(200);
  });
});
