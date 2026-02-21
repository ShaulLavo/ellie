import type { StandardSchemaV1 } from "@standard-schema/spec"
import { createRouter } from "@ellie/rpc/server"
import type { Router } from "@ellie/rpc"
import type {
  ProcedureConfigMap,
  ProcedureMethod,
  RouterFromDefs,
  StreamConfigMap,
  CollectionInput,
} from "./route-defs/types"

type BuilderMethod = `post` | `get` | `patch` | `delete`

const methodToBuilderMethod: Record<ProcedureMethod, BuilderMethod> = {
  POST: `post`,
  GET: `get`,
  PATCH: `patch`,
  DELETE: `delete`,
}

type RouterMutationConfig = {
  input: StandardSchemaV1
  output: StandardSchemaV1
}

type MutableRouter = {
  stream(
    name: string,
    path: string,
    collections: Record<string, CollectionInput>,
  ): MutableRouter
  post(name: string, path: string, config: RouterMutationConfig): MutableRouter
  get(name: string, path: string, config: RouterMutationConfig): MutableRouter
  patch(name: string, path: string, config: RouterMutationConfig): MutableRouter
  delete(name: string, path: string, config: RouterMutationConfig): MutableRouter
}

function asMutableRouter(router: unknown): MutableRouter {
  return router as MutableRouter
}

function applyStreams(router: MutableRouter, streams: StreamConfigMap): MutableRouter {
  for (const [name, stream] of Object.entries(streams)) {
    router = router.stream(name, stream.path, stream.collections)
  }
  return router
}

function applyProcedures(
  router: MutableRouter,
  procedures: ProcedureConfigMap
): MutableRouter {
  for (const [name, procedure] of Object.entries(procedures)) {
    const builderMethod = methodToBuilderMethod[procedure.method]
    router = router[builderMethod](name, procedure.path, {
      input: procedure.input,
      output: procedure.output,
    })
  }
  return router
}

export function buildRouter<
  TStreams extends StreamConfigMap,
  TProcedures extends ProcedureConfigMap,
>(
  streams: TStreams,
  procedures: TProcedures
): Router<RouterFromDefs<TStreams, TProcedures>> {
  const withStreams = applyStreams(asMutableRouter(createRouter()), streams)
  const withProcedures = applyProcedures(withStreams, procedures)
  return withProcedures as unknown as Router<RouterFromDefs<TStreams, TProcedures>>
}
