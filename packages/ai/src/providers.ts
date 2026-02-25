import type { ProviderName } from './types'

export interface ProviderInfo {
	name: ProviderName
	displayName: string
	requiresApiKey: boolean
	envKey: string | null
}

export const PROVIDERS: Record<ProviderName, ProviderInfo> =
	{
		anthropic: {
			name: 'anthropic',
			displayName: 'Anthropic',
			requiresApiKey: true,
			envKey: 'ANTHROPIC_API_KEY'
		},
		openai: {
			name: 'openai',
			displayName: 'OpenAI',
			requiresApiKey: true,
			envKey: 'OPENAI_API_KEY'
		},
		ollama: {
			name: 'ollama',
			displayName: 'Ollama',
			requiresApiKey: false,
			envKey: null
		},
		openrouter: {
			name: 'openrouter',
			displayName: 'OpenRouter',
			requiresApiKey: true,
			envKey: 'OPENROUTER_API_KEY'
		}
	}
