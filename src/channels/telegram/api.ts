import type {
  TelegramApiErrorData,
  TelegramFile,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./types";
import { TelegramApiError } from "./types";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * MIME type for an outbound audio upload, keyed off the extension.
 * Telegram uses this to decide whether a file gets the inline music
 * player; an mp3 sent as application/octet-stream shows up as a plain
 * document attachment instead.
 */
function audioMimeType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "m4a":
    case "aac":
      return "audio/mp4";
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "wav":
      return "audio/wav";
    case "flac":
      return "audio/flac";
    default:
      return "audio/mpeg";
  }
}

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export function classifyTelegramError(
  operation: string,
  status: number | undefined,
  description: string | undefined
): TelegramApiErrorData {
  const lower = (description ?? "").toLowerCase();
  if (status === 401 || lower.includes("unauthorized") || lower.includes("token")) {
    return { failureClass: "auth", connectionAffecting: true, operation, status, description };
  }
  if (status === 408) {
    return { failureClass: "timeout", connectionAffecting: true, operation, status, description };
  }
  if (status === 409 || lower.includes("terminated by other getupdates request")) {
    return { failureClass: "transport", connectionAffecting: true, operation, status, description };
  }
  if (status === 429 || (status !== undefined && status >= 500)) {
    return { failureClass: "transport", connectionAffecting: true, operation, status, description };
  }
  if (lower.includes("network") || lower.includes("fetch")) {
    return { failureClass: "network", connectionAffecting: true, operation, status, description };
  }
  if (
    lower.includes("message is not modified") ||
    lower.includes("message can't be edited") ||
    lower.includes("message to edit not found") ||
    lower.includes("bad request")
  ) {
    return { failureClass: "message", connectionAffecting: false, operation, status, description };
  }
  return {
    failureClass: "unknown",
    connectionAffecting: !(status !== undefined && status >= 400 && status < 500),
    operation,
    status,
    description,
  };
}

async function parseEnvelope<T>(response: Response, operation: string): Promise<T> {
  let payload: TelegramEnvelope<T> | undefined;
  try {
    payload = (await response.json()) as TelegramEnvelope<T>;
  } catch {
    throw new TelegramApiError(`${operation} failed with a non-JSON response`, {
      failureClass: "transport",
      connectionAffecting: true,
      operation,
      status: response.status,
      description: response.statusText,
    });
  }
  if (!response.ok || !payload.ok || payload.result === undefined) {
    const errorData = classifyTelegramError(
      operation,
      payload.error_code ?? response.status,
      payload.description ?? response.statusText
    );
    throw new TelegramApiError(payload.description ?? `${operation} failed`, errorData);
  }
  return payload.result;
}

async function telegramRequest<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    return await parseEnvelope<T>(response, method);
  } catch (error) {
    if (error instanceof TelegramApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new TelegramApiError(error instanceof Error ? error.message : String(error), {
      failureClass: "network",
      connectionAffecting: true,
      operation: method,
    });
  }
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface BotCommandScope {
  type: "default" | "chat" | "all_private_chats" | "all_group_chats";
  chat_id?: number;
}

export class TelegramApi {
  constructor(private readonly token: string) {}

  async getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return telegramRequest<TelegramUser>(this.token, "getMe", {}, signal);
  }

  async getUpdates(
    offset: number | undefined,
    timeoutSeconds: number,
    signal?: AbortSignal
  ): Promise<TelegramUpdate[]> {
    return telegramRequest<TelegramUpdate[]>(
      this.token,
      "getUpdates",
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "edited_message"],
      },
      signal
    );
  }

  async sendMessage(
    chatId: number,
    text: string,
    signal?: AbortSignal
  ): Promise<TelegramMessage> {
    return telegramRequest<TelegramMessage>(
      this.token,
      "sendMessage",
      {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      },
      signal
    );
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    signal?: AbortSignal
  ): Promise<TelegramMessage> {
    return telegramRequest<TelegramMessage>(
      this.token,
      "editMessageText",
      {
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
      },
      signal
    );
  }

  async deleteMessage(
    chatId: number,
    messageId: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    return telegramRequest<boolean>(
      this.token,
      "deleteMessage",
      { chat_id: chatId, message_id: messageId },
      signal
    );
  }

  async getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFile> {
    return telegramRequest<TelegramFile>(this.token, "getFile", { file_id: fileId }, signal);
  }

  async downloadFile(filePath: string, signal?: AbortSignal): Promise<Buffer> {
    const url = `${TELEGRAM_API_BASE}/file/bot${this.token}/${filePath}`;
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) {
        throw new TelegramApiError(`Failed to download file: ${response.statusText}`, {
          failureClass: "transport",
          connectionAffecting: false,
          operation: "downloadFile",
          status: response.status,
          description: response.statusText,
        });
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new TelegramApiError(error instanceof Error ? error.message : String(error), {
        failureClass: "network",
        connectionAffecting: false,
        operation: "downloadFile",
      });
    }
  }

  async sendPhoto(
    chatId: number,
    photoData: Buffer,
    filename: string,
    caption?: string,
    signal?: AbortSignal
  ): Promise<TelegramMessage> {
    const url = `${TELEGRAM_API_BASE}/bot${this.token}/sendPhoto`;
    const formData = new FormData();
    formData.append("chat_id", chatId.toString());
    const photoBytes = new Uint8Array(photoData.byteLength);
    photoBytes.set(photoData);
    formData.append("photo", new Blob([photoBytes], { type: "image/png" }), filename);
    if (caption) {
      formData.append("caption", caption);
    }

    try {
      const response = await fetch(url, { method: "POST", body: formData, signal });
      return await parseEnvelope<TelegramMessage>(response, "sendPhoto");
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new TelegramApiError(error instanceof Error ? error.message : String(error), {
        failureClass: "network",
        connectionAffecting: false,
        operation: "sendPhoto",
      });
    }
  }

  async sendAudio(
    chatId: number,
    audioData: Buffer,
    filename: string,
    caption?: string,
    meta?: { title?: string; performer?: string; duration?: number },
    signal?: AbortSignal
  ): Promise<TelegramMessage> {
    const url = `${TELEGRAM_API_BASE}/bot${this.token}/sendAudio`;
    const formData = new FormData();
    formData.append("chat_id", chatId.toString());
    const audioBytes = new Uint8Array(audioData.byteLength);
    audioBytes.set(audioData);
    formData.append(
      "audio",
      new Blob([audioBytes], { type: audioMimeType(filename) }),
      filename
    );
    if (caption) formData.append("caption", caption);
    // Telegram renders title/performer in the inline player. Without them
    // the client falls back to the filename, which is a ComfyUI artifact
    // name like `song_00007_.mp3` — not what the agent would call it.
    if (meta?.title) formData.append("title", meta.title);
    if (meta?.performer) formData.append("performer", meta.performer);
    if (meta?.duration && Number.isFinite(meta.duration)) {
      formData.append("duration", Math.round(meta.duration).toString());
    }

    try {
      const response = await fetch(url, { method: "POST", body: formData, signal });
      return await parseEnvelope<TelegramMessage>(response, "sendAudio");
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new TelegramApiError(error instanceof Error ? error.message : String(error), {
        failureClass: "network",
        connectionAffecting: false,
        operation: "sendAudio",
      });
    }
  }

  /**
   * Send a Telegram voice note — the waveform bubble with inline playback
   * and speed control, not the music-player row `sendAudio` produces.
   *
   * Telegram only renders the voice-note UI for OGG/Opus. Anything else is
   * silently demoted to a document attachment, so callers must transcode
   * first; `audioMimeType` tags .ogg/.opus as audio/ogg, which is what the
   * client keys off.
   *
   * `title`/`performer` are deliberately absent: /sendVoice ignores both.
   * `duration` is kept because it fills the scrub bar before the file has
   * finished downloading.
   */
  async sendVoice(
    chatId: number,
    voiceData: Buffer,
    filename: string,
    caption?: string,
    meta?: { duration?: number },
    signal?: AbortSignal
  ): Promise<TelegramMessage> {
    const url = `${TELEGRAM_API_BASE}/bot${this.token}/sendVoice`;
    const formData = new FormData();
    formData.append("chat_id", chatId.toString());
    const voiceBytes = new Uint8Array(voiceData.byteLength);
    voiceBytes.set(voiceData);
    formData.append(
      "voice",
      new Blob([voiceBytes], { type: audioMimeType(filename) }),
      filename
    );
    if (caption) formData.append("caption", caption);
    if (meta?.duration && Number.isFinite(meta.duration)) {
      formData.append("duration", Math.round(meta.duration).toString());
    }

    try {
      const response = await fetch(url, { method: "POST", body: formData, signal });
      return await parseEnvelope<TelegramMessage>(response, "sendVoice");
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new TelegramApiError(error instanceof Error ? error.message : String(error), {
        failureClass: "network",
        connectionAffecting: false,
        operation: "sendVoice",
      });
    }
  }

  async setMyCommands(
    commands: BotCommand[],
    scope?: BotCommandScope,
    signal?: AbortSignal
  ): Promise<boolean> {
    const body: Record<string, unknown> = { commands };
    if (scope) body.scope = scope;
    return telegramRequest<boolean>(this.token, "setMyCommands", body, signal);
  }
}
