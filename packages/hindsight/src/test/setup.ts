/**
 * Shared test utilities for @ellie/hindsight tests.
 *
 * Equivalent of conftest.py from the original Hindsight project.
 *
 * This barrel re-exports from focused modules:
 * - setup-fixtures: constants, credential detection, embedding fixtures
 * - setup-mocks: mock embedding function
 * - setup-factories: factory functions for test Hindsight instances
 */

export {
	EMBED_DIMS,
	EXTRACTION_TEST_MODE,
	EXTRACTION_TEST_CANONICAL_TIMEZONE,
	useRealLLMExtractionTests,
	HAS_ANTHROPIC_KEY,
	HAS_CREDENTIALS,
	HAS_ANTHROPIC,
	HAS_GROQ_KEY,
	HAS_GROQ,
	RUN_LLM_TESTS,
	describeWithLLM
} from './setup-fixtures'

export { mockEmbed } from './setup-mocks'

export type {
	TestHindsight,
	RealLLMTestHindsight,
	RealTestHindsight
} from './setup-factories'

export {
	createTestHindsight,
	createRealTestHindsight,
	getHdb,
	createTestBank
} from './setup-factories'
