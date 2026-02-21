import type { ProcedureDef, RouterDef } from "../types"

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
    ? ProcedureHandler<any, any>
    : never
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
  handlers: ProcedureHandlers<T>
): Promise<Response> | null {
  const method = req.method.toUpperCase()

  // Find matching procedure by path + method
  for (const [name, def] of Object.entries(routerDef)) {
    // Skip stream definitions
    if (`collections` in def) continue

    const procDef = def as ProcedureDef
    if (procDef.method !== method) continue

    const params = matchPath(pathname, procDef.path)
    if (!params) continue

    // Found a match — dispatch to handler
    const handler = (handlers as Record<string, ProcedureHandler>)[name]
    if (!handler) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: `No handler for procedure "${name}"` }),
          { status: 501, headers: { "content-type": `application/json` } }
        )
      )
    }

    return (async () => {
      try {
        let input: unknown

        if (method === `GET` || method === `DELETE`) {
          // Parse input from query params
          const url = new URL(req.url)
          const obj: Record<string, string> = {}
          for (const [k, v] of url.searchParams) {
            obj[k] = v
          }
          input = Object.keys(obj).length > 0 ? obj : undefined
        } else {
          // Parse input from JSON body
          const text = await req.text()
          input = text ? JSON.parse(text) : undefined
        }

        const result = await handler(input, params)

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
        const status = lower.includes(`not found`)
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

  // No procedure matched
  return null
}
