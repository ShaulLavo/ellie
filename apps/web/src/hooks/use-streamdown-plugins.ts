import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import type { Streamdown } from 'streamdown'

// Cast needed: @streamdown/code bundles shiki@3.22 types but streamdown uses shiki@3.23
export const streamdownPlugins = {
	cjk,
	code,
	math,
	mermaid
} as Parameters<typeof Streamdown>[0]['plugins']
