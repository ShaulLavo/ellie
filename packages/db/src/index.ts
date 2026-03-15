// Re-exports
export { openDatabase } from './init'
export { LogFile } from './log'
export { EventStore } from './event-store'
export { SpeechArtifactStore } from './speech-store'
export {
	DURABLE_EVENT_TYPES,
	isDurableEventType
} from './event-schemas'
export type {
	EventType,
	AppendInput,
	QueryInput,
	AgentMessage
} from './event-store'
export type { EventPayloadMap } from '@ellie/schemas/events'
export {
	projectReplies,
	type NormalizedReply,
	type NormalizedArtifact
} from './reply-projector'
export * as schema from './schema'
export type {
	ThreadRow,
	NewThreadRow,
	BranchRow,
	NewBranchRow,
	EventRow,
	NewEventRow,
	ThreadChannelRow,
	NewThreadChannelRow,
	AgentBootstrapStateRow,
	NewAgentBootstrapStateRow,
	SpeechArtifactRow,
	NewSpeechArtifactRow
} from './schema'
