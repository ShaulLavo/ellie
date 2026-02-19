import type { Model, ProviderName } from "../types";
import { MODELS } from "../models.generated";

// Build Map for O(1) lookups at module load
const registry = new Map<ProviderName, Map<string, Model>>();

for (const [provider, models] of Object.entries(MODELS)) {
	const modelMap = new Map<string, Model>();
	for (const [id, model] of Object.entries(models)) {
		modelMap.set(id, model);
	}
	registry.set(provider as ProviderName, modelMap);
}

/** Get a specific model by provider and model ID. */
export function getModel(
	provider: ProviderName,
	modelId: string
): Model | undefined {
	return registry.get(provider)?.get(modelId);
}

/** Get all models for a given provider. */
export function getModels(provider: ProviderName): Model[] {
	const models = registry.get(provider);
	return models ? Array.from(models.values()) : [];
}

/** Get all registered provider names. */
export function getProviders(): ProviderName[] {
	return Array.from(registry.keys());
}

/** Find a model by ID across all providers. */
export function findModel(modelId: string): Model | undefined {
	for (const models of registry.values()) {
		const model = models.get(modelId);
		if (model) return model;
	}
	return undefined;
}

/** Check if two models are the same (matching id and provider). */
export function modelsAreEqual(
	a: Model | null | undefined,
	b: Model | null | undefined
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}

export { MODELS } from "../models.generated";
