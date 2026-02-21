import type { ProcedureDef, RouterDef, StreamDef } from "../types"

// ============================================================================
// Types
// ============================================================================

/**
 * A single procedure handler function.
 * Receives the validated input and path params, returns the output.
 */
export type ProcedureHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  params: Record<string, string>
) => Promise<TOutput> | TOutput

/**
 * Map of procedure handlers for all procedures in a router.
 * Only includes keys whose definitions are ProcedureDef (not StreamDef).
 */
export type ProcedureHandlers<T extends RouterDef> = {
  [K in keyof T as T[K] extends ProcedureDef ? K : never]: T[K] extends ProcedureDef
    ? ProcedureHandler
    : never
}

/**
 * Partial procedure handler map, useful when a server only implements
 * a subset of a shared root router.
 */
export type PartialProcedureHandlers<T extends RouterDef> = Partial<ProcedureHandlers<T>>

type ProcedureEntry = { name: string; def: ProcedureDef; params: Record<string, string> }
type StreamEntry = { name: string; def: StreamDef; params: Record<string, string> }

export interface ProcedureDispatchOptions {
  onMissingHandler?: "error" | "skip"
}

// ============================================================================
// Path Matching
// ============================================================================

/**
 * Convert a path template like "/banks/:bankId/recall" to a regex
 * that captures named params.
 */
function pathToRegex(template: string): {
  regex: RegExp
  paramNames: string[]
} {
  const paramNames: string[] = []
  const regexStr = template.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    paramNames.push(name)
    return `([^/]+)`
  })
  return { regex: new RegExp(`^${regexStr}$`), paramNames }
}

/**
 * Try to match a pathname against a path template.
 * Returns extracted params on match, null otherwise.
 */
function matchPath(
  pathname: string,
  template: string
): Record<string, string> | null {
  const { regex, paramNames } = pathToRegex(template)
  const match = pathname.match(regex)
  if (!match) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < paramNames.length; i++) {
    params[paramNames[i]] = decodeURIComponent(match[i + 1])
  }
  return params
}

/**
 * Find a procedure route by pathname + method.
 */
export function findMatchingProcedure<T extends RouterDef>(
  routerDef: T,
  pathname: string,
  method: string
): ProcedureEntry | null {
  const upperMethod = method.toUpperCase()
  for (const [name, def] of Object.entries(routerDef)) {
    if (`collections` in def) continue

    const procedureDef = def as ProcedureDef
    if (procedureDef.method !== upperMethod) continue

    const params = matchPath(pathname, procedureDef.path)
    if (!params) continue

    return { name, def: procedureDef, params }
  }
  return null
}

/**
 * Find a stream route by pathname.
 */
export function findMatchingStream<T extends RouterDef>(
  routerDef: T,
  pathname: string
): StreamEntry | null {
  for (const [name, def] of Object.entries(routerDef)) {
    if (!(`collections` in def)) continue

    const streamDef = def as StreamDef
    const params = matchPath(pathname, streamDef.path)
    if (!params) continue

    return { name, def: streamDef, params }
  }
  return null
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle an incoming HTTP request by matching it against procedure definitions
 * in the router. Returns a Response if matched, or null if no procedure matched.
 *
 * @param routerDef - The router definition (from router._def)
 * @param req - The incoming Request
 * @param pathname - The URL pathname (already parsed, without query string)
 * @param handlers - Map of procedure name → handler function
 */
export function handleProcedureRequest<T extends RouterDef>(
  routerDef: T,
  req: Request,
  pathname: string,
  handlers: PartialProcedureHandlers<T>,
  options: ProcedureDispatchOptions = {}
): Promise<Response> | null {
  const method = req.method.toUpperCase()
  const matched = findMatchingProcedure(routerDef, pathname, method)
  if (!matched) return null

  const handler = (handlers as Record<string, ProcedureHandler | undefined>)[matched.name]
  if (!handler) {
    if (options.onMissingHandler === "skip") return null
    return Promise.resolve(
      new Response(
        JSON.stringify({ error: `No handler for procedure "${matched.name}"` }),
        { status: 501, headers: { "content-type": `application/json` } }
      )
    )
  }

  return (async () => {
    try {
      let input: unknown

      if (method === `GET` || method === `DELETE`) {
        const url = new URL(req.url)
        const obj: Record<string, string> = {}
        for (const [k, v] of url.searchParams) {
          obj[k] = v
        }
        input = Object.keys(obj).length > 0 ? obj : undefined
      } else {
        const text = await req.text()
        input = text ? JSON.parse(text) : undefined
      }

      const result = await handler(input, matched.params)

      if (result === undefined || result === null) {
        return new Response(null, { status: 204 })
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": `application/json` },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const lower = message.toLowerCase()
      const status = err instanceof SyntaxError
        ? 400
        : lower.includes(`not found`)
          ? 404
          : lower.includes(`missing`) || lower.includes(`empty`)
            ? 400
            : 500

      return new Response(
        JSON.stringify({ error: message }),
        { status, headers: { "content-type": `application/json` } }
      )
    }
  })()
}
