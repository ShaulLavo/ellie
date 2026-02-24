#!/usr/bin/env bun

import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { Model } from '../src/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageRoot = join(__dirname, '..')

interface ModelsDevModel {
	id: string
	name: string
	tool_call?: boolean
	reasoning?: boolean
	limit?: {
		context?: number
		output?: number
	}
	cost?: {
		input?: number
		output?: number
		cache_read?: number
		cache_write?: number
	}
	modalities?: {
		input?: string[]
	}
}

async function fetchOpenRouterModels(): Promise<Model[]> {
	try {
		console.log('Fetching models from OpenRouter API...')
		const response = await fetch('https://openrouter.ai/api/v1/models')
		const data = await response.json()

		const models: Model[] = []

		for (const model of data.data) {
			if (!model.supported_parameters?.includes('tools')) continue

			const input: ('text' | 'image')[] = ['text']
			if (model.architecture?.modality?.includes('image')) {
				input.push('image')
			}

			const inputCost = parseFloat(model.pricing?.prompt || '0') * 1_000_000
			const outputCost = parseFloat(model.pricing?.completion || '0') * 1_000_000
			const cacheReadCost = parseFloat(model.pricing?.input_cache_read || '0') * 1_000_000
			const cacheWriteCost = parseFloat(model.pricing?.input_cache_write || '0') * 1_000_000

			models.push({
				id: model.id,
				name: model.name,
				provider: 'openrouter',
				reasoning: model.supported_parameters?.includes('reasoning') || false,
				input,
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost
				},
				contextWindow: model.context_length || 4096,
				maxTokens: model.top_provider?.max_completion_tokens || 4096
			})
		}

		console.log(`Fetched ${models.length} tool-capable models from OpenRouter`)
		return models
	} catch (error) {
		console.error('Failed to fetch OpenRouter models:', error)
		return []
	}
}

async function loadModelsDevData(): Promise<Model[]> {
	try {
		console.log('Fetching models from models.dev API...')
		const response = await fetch('https://models.dev/api.json')
		const data = await response.json()

		const models: Model[] = []

		// Process Anthropic models
		if (data.anthropic?.models) {
			for (const [modelId, model] of Object.entries(data.anthropic.models)) {
				const m = model as ModelsDevModel
				if (m.tool_call !== true) continue

				models.push({
					id: modelId,
					name: m.name || modelId,
					provider: 'anthropic',
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes('image') ? ['text', 'image'] : ['text'],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096
				})
			}
		}

		// Process OpenAI models
		if (data.openai?.models) {
			for (const [modelId, model] of Object.entries(data.openai.models)) {
				const m = model as ModelsDevModel
				if (m.tool_call !== true) continue

				models.push({
					id: modelId,
					name: m.name || modelId,
					provider: 'openai',
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes('image') ? ['text', 'image'] : ['text'],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096
				})
			}
		}

		console.log(`Loaded ${models.length} tool-capable models from models.dev`)
		return models
	} catch (error) {
		console.error('Failed to load models.dev data:', error)
		return []
	}
}

async function generateModels() {
	const modelsDevModels = await loadModelsDevData()
	const openRouterModels = await fetchOpenRouterModels()

	const allModels = [...modelsDevModels, ...openRouterModels]

	// Fix incorrect cache pricing for Claude Opus 4.5 from models.dev
	const opus45 = allModels.find((m) => m.provider === 'anthropic' && m.id === 'claude-opus-4-5')
	if (opus45) {
		opus45.cost.cacheRead = 0.5
		opus45.cost.cacheWrite = 6.25
	}

	// Temporary overrides until upstream model metadata is corrected
	for (const candidate of allModels) {
		if (
			(candidate.provider === 'anthropic' || candidate.provider === 'openrouter') &&
			candidate.id === 'claude-opus-4-6'
		) {
			candidate.contextWindow = 200000
		}
	}

	// Add missing Claude Opus 4.6 if not present
	if (!allModels.some((m) => m.provider === 'anthropic' && m.id === 'claude-opus-4-6')) {
		allModels.push({
			id: 'claude-opus-4-6',
			name: 'Claude Opus 4.6',
			provider: 'anthropic',
			reasoning: true,
			input: ['text', 'image'],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25
			},
			contextWindow: 200000,
			maxTokens: 128000
		})
	}

	// Add "auto" alias for openrouter
	if (!allModels.some((m) => m.provider === 'openrouter' && m.id === 'auto')) {
		allModels.push({
			id: 'auto',
			name: 'Auto',
			provider: 'openrouter',
			reasoning: true,
			input: ['text', 'image'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 2000000,
			maxTokens: 30000
		})
	}

	// Filter to only our 4 supported providers
	const supportedProviders = new Set(['anthropic', 'openai', 'ollama', 'openrouter'])
	const filteredModels = allModels.filter((m) => supportedProviders.has(m.provider))

	// Group by provider and deduplicate by model ID
	const providers: Record<string, Record<string, Model>> = {}
	for (const model of filteredModels) {
		if (!providers[model.provider]) {
			providers[model.provider] = {}
		}
		// models.dev takes priority (added first)
		if (!providers[model.provider][model.id]) {
			providers[model.provider][model.id] = model
		}
	}

	// Ensure all 4 providers exist even if empty
	for (const p of supportedProviders) {
		if (!providers[p]) {
			providers[p] = {}
		}
	}

	// Generate TypeScript file
	let output = `// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'bun run generate-models' to update

import type { Model, ProviderName } from "./types";

export const MODELS: Record<ProviderName, Record<string, Model>> = {
`

	const sortedProviderIds = Object.keys(providers).sort()
	for (const providerId of sortedProviderIds) {
		const models = providers[providerId]
		output += `\t${JSON.stringify(providerId)}: {\n`

		const sortedModelIds = Object.keys(models).sort()
		for (const modelId of sortedModelIds) {
			const model = models[modelId]
			output += `\t\t${JSON.stringify(model.id)}: {\n`
			output += `\t\t\tid: ${JSON.stringify(model.id)},\n`
			output += `\t\t\tname: ${JSON.stringify(model.name)},\n`
			output += `\t\t\tprovider: ${JSON.stringify(model.provider)},\n`
			output += `\t\t\treasoning: ${model.reasoning},\n`
			output += `\t\t\tinput: [${model.input.map((i) => `"${i}"`).join(', ')}],\n`
			output += `\t\t\tcost: {\n`
			output += `\t\t\t\tinput: ${model.cost.input},\n`
			output += `\t\t\t\toutput: ${model.cost.output},\n`
			output += `\t\t\t\tcacheRead: ${model.cost.cacheRead},\n`
			output += `\t\t\t\tcacheWrite: ${model.cost.cacheWrite},\n`
			output += `\t\t\t},\n`
			output += `\t\t\tcontextWindow: ${model.contextWindow},\n`
			output += `\t\t\tmaxTokens: ${model.maxTokens},\n`
			output += `\t\t},\n`
		}

		output += `\t},\n`
	}

	output += `};\n`

	writeFileSync(join(packageRoot, 'src/models.generated.ts'), output)
	console.log('Generated src/models.generated.ts')

	// Print statistics
	const totalModels = filteredModels.length
	const reasoningModels = filteredModels.filter((m) => m.reasoning).length

	console.log(`\nModel Statistics:`)
	console.log(`  Total tool-capable models: ${totalModels}`)
	console.log(`  Reasoning-capable models: ${reasoningModels}`)

	for (const [provider, models] of Object.entries(providers)) {
		console.log(`  ${provider}: ${Object.keys(models).length} models`)
	}
}

generateModels().catch(console.error)
