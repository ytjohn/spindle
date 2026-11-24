import type { ImageContent } from "@earendil-works/pi-ai";

// ==================== Telegram API Types ====================

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
  title?: string;
  username?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideoNote {
  file_id: string;
  file_unique_id: string;
  length: number;
  duration: number;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  chat: TelegramChat;
  reply_to_message?: TelegramMessage;
  edit_date?: number;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

// ==================== Error Classification ====================

export type FailureClass =
  | "auth"
  | "network"
  | "timeout"
  | "transport"
  | "message"
  | "unknown";

export interface TelegramApiErrorData {
  failureClass: FailureClass;
  connectionAffecting: boolean;
  operation: string;
  status?: number;
  description?: string;
}

export class TelegramApiError extends Error {
  readonly failureClass: FailureClass;
  readonly connectionAffecting: boolean;
  readonly operation: string;
  readonly status?: number;
  readonly description?: string;

  constructor(message: string, data: TelegramApiErrorData) {
    super(message);
    this.name = "TelegramApiError";
    this.failureClass = data.failureClass;
    this.connectionAffecting = data.connectionAffecting;
    this.operation = data.operation;
    this.status = data.status;
    this.description = data.description;
  }
}

// ==================== Channel State ====================

export type ConnectionState = "connected" | "disconnected" | "connecting";

export interface TelegramChannelConfig {
  botToken: string;
  allowedUsers: UserAccess[];
  filesDirectory: string;
}

// ==================== Multi-User Access ====================

/**
 * Describes which Telegram users may talk to the agent and how their sessions
 * are routed. Phase 3 only honors `id` — the optional `session` and `access`
 * fields are accepted by the schema but not yet enforced, leaving room for a
 * future `PerUserSessionRouter` without a config migration.
 */
export interface UserAccess {
  id: number;
  session?: string;
  access?: "full" | "single" | "room";
}

// ==================== Queue ====================

export interface QueuedMessage {
  seq: number;
  telegramMessageId: number;
  senderId: number;
  text: string;
  /** Native multimodal attachments, if the message carried images. */
  images?: ImageContent[];
  receivedAt: number;
  dispatched: boolean;
}
