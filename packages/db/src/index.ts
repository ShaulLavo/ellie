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
export { AuditLogger } from './audit-log'
export type { AuditEntry } from './audit-log'
export * as schema from './schema'
export type {
	SessionRow,
	NewSessionRow,
	EventRow,
	NewEventRow,
	AgentBootstrapStateRow,
	NewAgentBootstrapStateRow
} from './schema'
