/**
 * Content-type handlers for browser-rendered HTML, PDFs, and media.
 */

import pdf2md from '@opendocsg/pdf2md'
import type { AgentToolResult } from '@ellie/agent'
import {
	MAX_CONTENT_CHARS,
	truncateText,
	formatBytes
} from './common'
import { callWorker } from './fetch-worker'

export async function handleBrowser(
	url: string,
	signal?: AbortSignal
): Promise<AgentToolResult> {
	const result = await callWorker(
		w => w.fetchPage(url),
		signal
	)

	const parts: string[] = []
	if (result.title) parts.push(`# ${result.title}`)
	if (result.author)
		parts.push(`**Author:** ${result.author}`)
	if (result.content) parts.push(result.content)

	const text = parts.join('\n\n')
	const truncated = truncateText(text, MAX_CONTENT_CHARS)

	return {
		content: [
			{
				type: 'text',
				text: truncated || '(no readable content found)'
			}
		],
		details: {
			url,
			title: result.title,
			author: result.author,
			wordCount: result.wordCount
		}
	}
}

export async function handlePdf(
	response: Response,
	url: string
): Promise<AgentToolResult> {
	const buffer = await response.arrayBuffer()
	const markdown = await pdf2md(buffer)
	const truncated = truncateText(
		markdown,
		MAX_CONTENT_CHARS
	)

	return {
		content: [
			{
				type: 'text',
				text: truncated || '(no text extracted from PDF)'
			}
		],
		details: {
			url,
			contentType: 'application/pdf',
			charCount: markdown.length
		}
	}
}

export function handleMedia(
	url: string,
	contentType: string,
	contentLength: string | null
): AgentToolResult {
	const size = contentLength
		? `\nSize: ${formatBytes(parseInt(contentLength, 10))}`
		: ''

	return {
		content: [
			{
				type: 'text',
				text: `Media resource: ${url}\nContent-Type: ${contentType}${size}`
			}
		],
		details: {
			url,
			contentType,
			contentLength: contentLength
				? parseInt(contentLength, 10)
				: null
		}
	}
}
