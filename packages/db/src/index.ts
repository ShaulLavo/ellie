// Re-exports
export { openDatabase } from './init'
export { LogFile } from './log'
export { EventStore } from './event-store'
export type {
	EventType,
	AppendInput,
	QueryInput,
	AgentMessage
} from './event-store'
export type { EventPayloadMap } from '@ellie/schemas/events'
export { AuditLogger } from './audit-log'
export type { AuditEntry, AuditLevel } from './audit-log'
export * as schema from './schema'
export type {
	SessionRow,
	NewSessionRow,
	EventRow,
	NewEventRow,
	AgentBootstrapStateRow,
	NewAgentBootstrapStateRow
} from './schema'
