/** Settings stored per account in DATA_DIR/channels/<channelId>/<accountId>/settings.json */
export interface ChannelAccountSettings {
	[key: string]: unknown
}

/** Runtime status for a channel account */
export interface ChannelRuntimeStatus {
	state:
		| 'disconnected'
		| 'connecting'
		| 'connected'
		| 'error'
	detail?: string
	error?: string
	/** Epoch ms when connection opened */
	connectedAt?: number
	/** Consecutive reconnect attempts (resets on connect) */
	reconnectAttempts: number
	/** Epoch ms of most recent successful connect */
	lastConnectedAt?: number
	/** Reason string from last disconnect */
	lastDisconnect?: string
	/** Epoch ms of last inbound message processed */
	lastMessageAt?: number
	/** Epoch ms of last Baileys event */
	lastEventAt?: number
	/** Most recent error message */
	lastError?: string
	/** Bot's own E.164 or JID */
	selfId?: string
}

/** Inbound message from any channel */
export interface ChannelInboundMessage {
	channelId: string
	accountId: string
	conversationId: string
	senderId: string
	senderName?: string
	text: string
	timestamp: number
	/** Channel-specific message ID (e.g. WhatsApp msg.key.id). When present, used as dedupe key instead of content hash. */
	externalId?: string
	/** Local file path to downloaded media (image, video, document, etc.) */
	mediaPath?: string
	/** MIME type of the downloaded media */
	mediaType?: string
	/** Original file name of the media (if available) */
	mediaFileName?: string
}

/** Delivery target — stored in registry, used to route replies back */
export interface ChannelDeliveryTarget {
	channelId: string
	accountId: string
	conversationId: string
	/** MIME type of inbound media (e.g. 'audio/ogg; codecs=opus'). Used by auto-TTS 'inbound' mode. */
	inboundMediaType?: string
}
