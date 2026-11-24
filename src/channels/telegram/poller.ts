import { readFileSync, writeFileSync } from "fs";
import type { TelegramApi } from "./api";
import type { TelegramUpdate } from "./types";
import { TelegramApiError } from "./types";

const DEFAULT_POLL_TIMEOUT_S = 30;
const DEFAULT_RETRY_INTERVAL_MS = 5_000;
const CLIENT_TIMEOUT_BUFFER_MS = 15_000;
const WARMUP_POLL_TIMEOUT_S = 0;

export interface PollerOptions {
  api: TelegramApi;
  onUpdate: (update: TelegramUpdate) => Promise<void>;
  onError?: (error: TelegramApiError) => void;
  onConnected?: () => void;
  pollTimeoutSeconds?: number;
  retryIntervalMs?: number;
  /**
   * Path to persist the last-seen update_id across restarts.
   * When set, the poller loads the saved offset on start and writes
   * it after each batch — preventing message replay on restart.
   */
  offsetFile?: string;
}

/**
 * Long-poll loop against Telegram's getUpdates endpoint.
 *
 * - Offset tracking prevents re-processing updates.
 * - Generation counter lets `stop()` invalidate an in-flight loop immediately.
 * - AbortController cleanly cancels the in-flight fetch.
 * - Transient errors retry after `retryIntervalMs`.
 * - Auth errors stop the loop permanently (bot token invalid).
 */
export class TelegramPoller {
  private readonly api: TelegramApi;
  private readonly onUpdate: (update: TelegramUpdate) => Promise<void>;
  private readonly onError?: (error: TelegramApiError) => void;
  private readonly onConnected?: () => void;
  private readonly pollTimeoutSeconds: number;
  private readonly retryIntervalMs: number;

  private currentOffset: number | undefined = undefined;
  private running = false;
  private generation = 0;
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private hasConnectedOnce = false;
  private readonly offsetFile: string | undefined;

  constructor(options: PollerOptions) {
    this.api = options.api;
    this.onUpdate = options.onUpdate;
    this.onError = options.onError;
    this.onConnected = options.onConnected;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_S;
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    this.offsetFile = options.offsetFile;
    // Load persisted offset so restarts don't replay already-seen updates.
    if (this.offsetFile) {
      this.currentOffset = this.loadOffset();
    }
  }

  private loadOffset(): number | undefined {
    try {
      const raw = readFileSync(this.offsetFile!, "utf8");
      const parsed = JSON.parse(raw) as { offset?: unknown };
      return typeof parsed.offset === "number" ? parsed.offset : undefined;
    } catch {
      return undefined;
    }
  }

  private saveOffset(offset: number): void {
    try {
      writeFileSync(this.offsetFile!, JSON.stringify({ offset }));
    } catch {
      // Non-fatal — worst case is a replay on next restart
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    const myGeneration = ++this.generation;
    this.running = true;
    this.loopPromise = this.loop(myGeneration).finally(() => {
      if (myGeneration === this.generation) {
        this.running = false;
        this.loopPromise = null;
      }
    });
  }

  async stop(): Promise<void> {
    this.generation++;
    this.running = false;
    this.abortController?.abort();
    const promise = this.loopPromise;
    if (promise) {
      try {
        await promise;
      } catch {
        // Loop errors are already delivered via onError
      }
    }
    this.loopPromise = null;
  }

  private async loop(generation: number): Promise<void> {
    let firstPoll = true;

    while (generation === this.generation) {
      const controller = new AbortController();
      this.abortController = controller;
      const pollTimeout = firstPoll ? WARMUP_POLL_TIMEOUT_S : this.pollTimeoutSeconds;
      const clientTimeoutMs = pollTimeout * 1000 + CLIENT_TIMEOUT_BUFFER_MS;
      const clientTimer = setTimeout(() => controller.abort(), clientTimeoutMs);

      try {
        const updates = await this.api.getUpdates(
          this.currentOffset,
          pollTimeout,
          controller.signal
        );
        clearTimeout(clientTimer);

        if (generation !== this.generation) break;

        if (!this.hasConnectedOnce) {
          this.hasConnectedOnce = true;
          this.onConnected?.();
        }
        firstPoll = false;

        for (const update of updates) {
          if (generation !== this.generation) break;
          this.currentOffset = update.update_id + 1;
          if (this.offsetFile) this.saveOffset(this.currentOffset);
          try {
            await this.onUpdate(update);
          } catch (err) {
            // Update handlers are user code; don't let one bad update kill the loop.
            // Surface via onError if available, else rethrow for visibility.
            if (this.onError) {
              this.onError(
                err instanceof TelegramApiError
                  ? err
                  : new TelegramApiError(
                      err instanceof Error ? err.message : String(err),
                      {
                        failureClass: "unknown",
                        connectionAffecting: false,
                        operation: "onUpdate",
                      }
                    )
              );
            } else {
              throw err;
            }
          }
        }
      } catch (err) {
        clearTimeout(clientTimer);

        if (this.isAbortError(err)) {
          // Expected when stop() is called — exit cleanly.
          if (generation !== this.generation) break;
          // Otherwise it was our own client-side timeout; retry immediately.
          continue;
        }

        const normalized =
          err instanceof TelegramApiError
            ? err
            : new TelegramApiError(err instanceof Error ? err.message : String(err), {
                failureClass: "network",
                connectionAffecting: true,
                operation: "getUpdates",
              });

        this.onError?.(normalized);

        // Auth errors are terminal — the bot token is bad, retrying won't help.
        if (normalized.failureClass === "auth") {
          this.generation++;
          break;
        }

        // Sleep before retrying transient errors
        await this.sleep(this.retryIntervalMs, controller.signal);
        if (generation !== this.generation) break;
      } finally {
        clearTimeout(clientTimer);
        if (this.abortController === controller) {
          this.abortController = null;
        }
      }
    }
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }
}
