/**
 * The surface a plugin or extension outside this repository builds on.
 *
 * Everything here is re-exported from the module that owns it; nothing is
 * defined in this file. What is NOT exported here is internal and may
 * change without notice.
 *
 * Three ways to reach it, in order of preference:
 *
 *   1. A plugin module (agent.yaml `plugins:`) may export a function; it
 *      is called with this API as its argument, so the plugin needs no
 *      import path to spindle at run time — `import type` is enough.
 *   2. `import { ... } from "spindle/api"` where spindle is installed or
 *      linked as a package.
 *   3. `globalThis[Symbol.for("@spindle/api")]`, for a pi extension
 *      (loaded by pi, which hands it only its own `pi` object) that has
 *      neither of the above.
 *
 * All state behind these functions lives in process-wide slots, so it
 * does not matter which of the three a caller used or how many copies of
 * a module pi's loader made.
 */

// Channels and plugins
export type { Channel, ChannelLiveness, SlashCommandInfo } from "./channels/types";
export type { ChannelPlugin, ChannelHost } from "./channels/registry";
export type { SpindlePlugin, SpindlePluginModule } from "./plugins/loader";
export type { AgentConfig } from "./types";
export type { SharedSessionDeps } from "./agent/session";

// What a channel declares about itself, for extensions that act on it
export {
  channelCapabilities,
  declareChannelCapabilities,
  declaredChannels,
  type ChannelCapabilities,
} from "./channels/capabilities";

// Which kind of session is loading extensions right now
export { bindSessionKind, getSessionKind, isMainSession, type SessionKind } from "./agent/session-kind";

// Provenance: who a message came from, and who owns the current run
export { ProvenanceTracker, createProvenanceTracker, findPersistedEntry, origin } from "./provenance/tracker";
export type { DispatchOptions, TrackerSession } from "./provenance/tracker";
export {
  bindProvenanceTracker,
  getProvenanceTracker,
  registerSessionTracker,
  trackerFor,
} from "./provenance/binding";
export { extensionOrigin, sendUserMessageFrom, type SendFromOptions } from "./provenance/extension";
export type {
  Delivery as PromptDelivery,
  Origin,
  OriginEntryData,
  OriginRecord,
  Place,
  ProvenanceEvent,
  RunEndEntryData,
  RunEntryData,
  RunRecord,
} from "./provenance/types";
// The custom entries provenance writes into a session transcript. The
// names are a persisted format: existing transcripts use them.
export { ORIGIN_ENTRY_TYPE, RUN_END_ENTRY_TYPE, RUN_ENTRY_TYPE } from "./provenance/types";
export { placeOf } from "./channels/place";

// A saved helper session beside the main one
export { createOneOffSession, type OneOffSessionOptions } from "./agent/helper-session";

// Ending a turn on purpose
export { requestStopAfterTurn, setQueuedHandler, type QueuedHandler } from "./agent/stop-after-turn";
export { consumePlannedAbort, markPlannedAbort } from "./agent/planned-abort";

// Deliveries to the operator
export {
  deliver,
  fromContext,
  getOutboundLog,
  hasDestination,
  registerDestination,
  unregisterDestination,
} from "./outbound";
export type { Delivery, DeliverInput, DeliveryFrom, DeliveryKind, Destination, Urgency } from "./outbound";

// Media the agent sent or received
export { getMediaLog, isInbound, mimeFor, newMediaId } from "./media/log";
export type { DeliveredMedia, MediaContext, MediaInput, MediaType } from "./media/log";
export { closeLiveAudio, getLiveAudio, openLiveAudio, pcmContentType, type LiveAudio } from "./media/live";
export {
  imagePrompt,
  imageSentinel,
  voiceSentinel,
  voiceSentinelUntranscribed,
} from "./media/inbound";

// Speech recognition
export { resolveAsrSettings, transcribeAudioFile } from "./speech/asr";
export type { AsrOutcome, AsrSettings, AsrTrace } from "./speech/asr";

// Telegram, when the agent has it
export {
  getBoundTelegramChannel,
  getTelegramPendingMs,
  getTelegramTurnActiveMs,
  hideToolProgress,
} from "./channels/telegram/binding";
export { formatVoiceNoteLogLine } from "./channels/telegram/files";

// Tool calls a model wrote out as text
export {
  containsFakeToolCall,
  hasCallShapedContent,
  knownToolNames,
  maskFakeToolCalls,
  parseFakeToolCalls,
  primaryArg,
  registerKnownToolNames,
  registerRelayToolNames,
  type ParsedFakeCall,
} from "./util/fake-tool-calls";

// HTTP
export { createBearerAuthPreHandler } from "./web/auth";
export { createHttpServer } from "./web/http";
export type { FastifyInstance, FastifyReply, FastifyRequest } from "./web/http";
