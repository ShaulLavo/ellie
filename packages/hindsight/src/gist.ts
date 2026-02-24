/**
 * Gist generation pipeline for Phase 3 context packing.
 *
 * - Eager gist: generated inline when content.length <= 2000 chars
 * - Async gist: queued for background generation when content > 2000 chars
 * - Fallback: deterministic truncation to 280 chars with "..."
 *
 * Gist format contract:
 * - max 280 chars
 * - must include primary entity/action/outcome when present
 * - plain text only
 */

import { chat, streamToText } from "@ellie/ai";
import type { AnyTextAdapter } from "@tanstack/ai";
import { generateFallbackGist } from "./context-pack";

// ── Constants ───────────────────────────────────────────────────────────────

/** Content length threshold for eager vs async gist generation. */
export const EAGER_GIST_THRESHOLD = 2000;

/** Maximum gist length in characters. */
export const MAX_GIST_LENGTH = 280;

// ── Types ───────────────────────────────────────────────────────────────────

export interface GistResult {
  gist: string;
  mode: "eager" | "async" | "fallback";
}

// ── LLM-based gist generation ───────────────────────────────────────────────

const GIST_SYSTEM_PROMPT = `You are a memory compression engine. Given a piece of stored knowledge, produce a gist that:
- Is at most 280 characters
- Captures the primary entity, action, and outcome
- Uses plain text only (no markdown, no bullets)
- Is a single concise sentence or fragment
- Preserves the most critical information for later retrieval

Output ONLY the gist text, nothing else.`;

/**
 * Generate a gist from content using an LLM adapter.
 * Returns the gist text (max 280 chars).
 */
export async function generateGistWithLLM(
  adapter: AnyTextAdapter,
  content: string,
): Promise<string> {
  const truncatedContent =
    content.length > 4000 ? content.slice(0, 4000) + "..." : content;

  const response = await streamToText(
    chat({
      adapter,
      messages: [{ role: "user", content: truncatedContent }],
      systemPrompts: [GIST_SYSTEM_PROMPT],
    }),
  );

  let gist = response.trim();
  if (gist.length > MAX_GIST_LENGTH) {
    gist = gist.slice(0, MAX_GIST_LENGTH - 3) + "...";
  }
  return gist;
}

/**
 * Generate a gist for content, choosing eager/async/fallback strategy.
 *
 * - Eager: content <= EAGER_GIST_THRESHOLD — generate inline with LLM
 * - Async: content > EAGER_GIST_THRESHOLD — return fallback now, queue LLM generation
 * - Fallback: if LLM fails, deterministic truncation
 *
 * @param adapter - LLM adapter for gist generation
 * @param content - The memory content to summarize
 * @param onAsyncGist - Optional callback invoked when async gist completes
 */
export async function generateGist(
  adapter: AnyTextAdapter,
  content: string,
  onAsyncGist?: (gist: string) => void,
): Promise<GistResult> {
  if (content.length <= EAGER_GIST_THRESHOLD) {
    // Eager: generate inline
    try {
      const gist = await generateGistWithLLM(adapter, content);
      return { gist, mode: "eager" };
    } catch {
      return { gist: generateFallbackGist(content), mode: "fallback" };
    }
  }

  // Async: return fallback immediately, queue LLM in background
  const fallback = generateFallbackGist(content);

  if (onAsyncGist) {
    // Fire-and-forget background generation
    generateGistWithLLM(adapter, content)
      .then((gist) => onAsyncGist(gist))
      .catch((err) => {
        // Fallback already set; log for diagnostics
        console.debug?.("[gist] async generation failed:", err);
      });
  }

  return { gist: fallback, mode: "async" };
}
