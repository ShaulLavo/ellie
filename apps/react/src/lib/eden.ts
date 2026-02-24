import { treaty } from '@elysiajs/eden'
import { env } from '@ellie/env/client'
import type { App } from 'app'

const baseUrl = env.API_BASE_URL.replace(/\/$/, ``)

export const eden = treaty<App>(baseUrl)
