import type { AgentToolResult } from '@ellie/agent'
import {
	MAX_OUTPUT_CHARS,
	USER_AGENT,
	truncateText,
	errorResult
} from './common'

const REDDIT_HOST_RE = /^(?:www\.)?(?:old\.)?reddit\.com$/

export function isRedditUrl(url: string): boolean {
	try {
		return REDDIT_HOST_RE.test(new URL(url).hostname)
	} catch {
		return false
	}
}

/** Convert a Reddit URL to its JSON API equivalent. */
function toRedditJsonUrl(url: string): string {
	const u = new URL(url)
	// Strip trailing slash, append .json
	u.pathname = u.pathname.replace(/\/+$/, '') + '.json'
	// Carry over query params (e.g. ?t=day)
	return u.toString()
}

interface RedditPost {
	title: string
	score: number
	author: string
	url: string
	permalink: string
	selftext: string
	num_comments: number
	subreddit: string
	created_utc: number
}

interface RedditComment {
	author: string
	body: string
	score: number
	depth: number
	replies?: { data?: { children?: RedditCommentChild[] } }
}

interface RedditCommentChild {
	kind: string
	data: RedditComment
}

function compactNumber(n: number): string {
	if (n >= 1_000_000)
		return (n / 1_000_000).toFixed(1) + 'M'
	if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
	return String(n)
}

function formatRedditListing(
	posts: RedditPost[],
	subreddit: string
): string {
	const lines: string[] = [`r/${subreddit}\n`]
	for (let i = 0; i < posts.length; i++) {
		const p = posts[i]
		lines.push(
			`${i + 1}. ${p.title} [↑${compactNumber(p.score)} · ${compactNumber(p.num_comments)}c · u/${p.author}]`,
			`   https://reddit.com${p.permalink}`
		)
	}
	return lines.join('\n')
}

function formatRedditThread(
	post: RedditPost,
	comments: RedditComment[]
): string {
	const lines: string[] = [
		post.title,
		`↑${compactNumber(post.score)} · ${compactNumber(post.num_comments)}c · u/${post.author}`
	]
	if (post.url && !post.url.includes('reddit.com'))
		lines.push(post.url)
	if (post.selftext) lines.push('', post.selftext)

	if (comments.length) {
		lines.push('', '---')
		for (const c of comments) {
			const indent = '> '.repeat(c.depth)
			lines.push(
				`${indent}u/${c.author} [↑${compactNumber(c.score)}]: ${c.body.replaceAll('\n', '\n' + indent)}`
			)
		}
	}
	return lines.join('\n')
}

/** Flatten comment tree to a list, depth-first. */
function flattenComments(
	children: RedditCommentChild[],
	depth = 0,
	max = 30
): RedditComment[] {
	const out: RedditComment[] = []
	for (const child of children) {
		if (out.length >= max) break
		if (child.kind !== 't1') continue
		const c = child.data
		out.push({
			author: c.author,
			body: c.body,
			score: c.score,
			depth
		})
		if (c.replies?.data?.children) {
			out.push(
				...flattenComments(
					c.replies.data.children,
					depth + 1,
					max - out.length
				)
			)
		}
	}
	return out
}

export async function handleReddit(
	url: string
): Promise<AgentToolResult> {
	const jsonUrl = toRedditJsonUrl(url)
	const res = await fetch(jsonUrl, {
		headers: { 'User-Agent': USER_AGENT }
	})
	if (!res.ok) {
		return errorResult(
			`Reddit API: HTTP ${res.status} ${res.statusText}`
		)
	}
	const data = await res.json()

	// Listing page (subreddit feed, search, etc.)
	if (!Array.isArray(data)) {
		const listing = data?.data?.children ?? []
		const posts: RedditPost[] = listing.map(
			(c: { data: RedditPost }) => c.data
		)
		const sub =
			posts[0]?.subreddit ??
			url.match(/\/r\/(\w+)/)?.[1] ??
			'reddit'

		const text = formatRedditListing(posts, sub)
		const truncated = truncateText(text, MAX_OUTPUT_CHARS)

		return {
			content: [{ type: 'text', text: truncated }],
			details: {
				url,
				source: 'reddit-json',
				postCount: posts.length
			}
		}
	}

	// Thread page — array of [post listing, comments listing]
	const postData = data[0]?.data?.children?.[0]?.data as
		| RedditPost
		| undefined
	if (!postData)
		return errorResult('Reddit: could not parse thread')

	const commentChildren: RedditCommentChild[] =
		data[1]?.data?.children ?? []
	const comments = flattenComments(commentChildren)

	const text = formatRedditThread(postData, comments)
	const truncated = truncateText(text, MAX_OUTPUT_CHARS)

	return {
		content: [{ type: 'text', text: truncated }],
		details: {
			url,
			source: 'reddit-json',
			title: postData.title,
			author: postData.author,
			commentCount: comments.length
		}
	}
}
