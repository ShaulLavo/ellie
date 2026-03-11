import type { ChannelManager } from './manager'
import type {
	ChannelAccountSettings,
	ChannelRuntimeStatus,
	ChannelDeliveryTarget
} from './types'

/**
 * Standard contract every channel provider implements.
 * Account-aware from day one (accountId = "default" for v0).
 */
export interface ChannelProvider {
	/** Unique identifier: 'whatsapp', 'telegram', etc. */
	readonly id: string
	/** Human-readable name */
	readonly displayName: string

	/** Called on server start if saved settings exist. */
	boot(manager: ChannelManager): Promise<void>
	/** Clean shutdown */
	shutdown(): Promise<void>

	/** Get runtime status for a specific account */
	getStatus(accountId: string): ChannelRuntimeStatus

	/** Begin login flow — returns provider-specific data (e.g. QR code data) */
	loginStart(
		accountId: string,
		settings: ChannelAccountSettings
	): Promise<unknown>
	/** Block until login completes — returns provider-specific result */
	loginWait(accountId: string): Promise<unknown>
	/** Disconnect and clean up */
	logout(accountId: string): Promise<void>

	/** Update settings for an account */
	updateSettings(
		accountId: string,
		settings: ChannelAccountSettings
	): void

	/** Send a text message to a channel target */
	sendMessage(
		target: ChannelDeliveryTarget,
		text: string
	): Promise<{ messageId?: string }>

	/** Send a media message (optional — not all channels support it) */
	sendMedia?(
		target: ChannelDeliveryTarget,
		text: string,
		media: {
			buffer: Buffer
			mimetype: string
			fileName?: string
		}
	): Promise<{ messageId?: string }>

	/** Send a poll (optional — not all channels support it) */
	sendPoll?(
		target: ChannelDeliveryTarget,
		poll: {
			question: string
			options: string[]
			maxSelections?: number
		}
	): Promise<{ messageId?: string }>

	/** Send a reaction (optional — not all channels support it) */
	sendReaction?(
		target: ChannelDeliveryTarget,
		messageId: string,
		emoji: string,
		fromMe?: boolean
	): Promise<void>

	/** Send "composing" typing indicator (optional) */
	sendComposing?(
		target: ChannelDeliveryTarget
	): Promise<void>

	/** Check if the account is ready to send messages (optional) */
	isReady?(accountId: string): {
		ok: boolean
		reason: string
	}

	/**
	 * Wait until all booted accounts are connected and ready to send.
	 * Resolves immediately if already connected. Rejects on timeout.
	 * Used by crash recovery to ensure delivery doesn't race socket open.
	 */
	waitForReady?(timeoutMs?: number): Promise<void>
}
