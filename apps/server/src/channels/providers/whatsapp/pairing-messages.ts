/**
 * Pairing reply message templates.
 * Adapted from openclaw's pairing flow.
 */

export function buildPairingReply(params: {
	senderE164: string
	code: string
}): string {
	return [
		'Ellie: access not configured.',
		'',
		`Your WhatsApp number: ${params.senderE164}`,
		'',
		`Pairing code: ${params.code}`,
		'',
		'Ask the bot owner to approve with:',
		`  ellie pair approve whatsapp ${params.code}`
	].join('\n')
}
