export const API_TAGS = [
	{ name: 'Status', description: 'Server status' },
	{
		name: 'Chat',
		description: 'Chat sessions and messages'
	},
	{
		name: 'Agent',
		description: 'Agent management'
	},
	{
		name: 'Auth',
		description: 'Anthropic credential management'
	},
	{
		name: 'Session',
		description: 'Session management'
	},
	{
		name: 'Uploads',
		description: 'Tus upload management'
	},
	{
		name: 'Channels',
		description: 'External messaging channels'
	}
] as const

export const API_INFO = {
	title: 'Ellie API',
	version: '1.0.0'
} as const
