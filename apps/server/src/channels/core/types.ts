/** Settings stored per account in DATA_DIR/channels/<channelId>/<accountId>/settings.json */
export interface ChannelAccountSettings {
	[key: string]: unknown
}

/** Runtime status for a channel account */
export type ChannelRuntimeStatus =
	| { state: 'disconnected' }
	| { state: 'connecting'; detail?: string }
	| { state: 'connected'; connectedAt: number }
	| { state: 'error'; error: string }

/** Inbound message from any channel */
export interface ChannelInboundMessage {
	channelId: string
	accountId: string
	conversationId: string
	senderId: string
	senderName?: string
	text: string
	timestamp: number
}

/** Delivery target — stored in registry, used to route replies back */
export interface ChannelDeliveryTarget {
	channelId: string
	accountId: string
	conversationId: string
}
