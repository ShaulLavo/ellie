import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { CollectionDef, ProcedureDef, StreamDef } from "@ellie/rpc"

export type ProcedureMethod = `POST` | `GET` | `PATCH` | `DELETE`

export type CollectionInput =
  | StandardSchemaV1
  | {
      schema: StandardSchemaV1
      type?: string
      primaryKey?: string
    }

export type StreamConfig = {
  path: string
  collections: Record<string, CollectionInput>
}

export type ProcedureConfig = {
  method: ProcedureMethod
  path: string
  input: StandardSchemaV1
  output: StandardSchemaV1
}

export type StreamConfigMap = Record<string, StreamConfig>
export type ProcedureConfigMap = Record<string, ProcedureConfig>

export function defineStreams<TStreams extends StreamConfigMap>(
  streams: TStreams
): TStreams {
  return streams
}

export function defineProcedures<TProcedures extends ProcedureConfigMap>(
  procedures: TProcedures
): TProcedures {
  return procedures
}

type NormalizeCollections<TCollections extends Record<string, CollectionInput>> = {
  [K in keyof TCollections]:
    TCollections[K] extends StandardSchemaV1
      ? CollectionDef<TCollections[K], string, string>
      : TCollections[K] extends { schema: infer TSchema extends StandardSchemaV1 }
        ? CollectionDef<TSchema, string, string>
        : never
}

export type StreamDefsFromConfig<TStreams extends StreamConfigMap> = {
  [K in keyof TStreams]: StreamDef<
    TStreams[K][`path`],
    NormalizeCollections<TStreams[K][`collections`]>
  >
}

export type ProcedureDefsFromConfig<TProcedures extends ProcedureConfigMap> = {
  [K in keyof TProcedures]: ProcedureDef<
    TProcedures[K][`path`],
    TProcedures[K][`input`],
    TProcedures[K][`output`],
    TProcedures[K][`method`]
  >
}

export type RouterFromDefs<
  TStreams extends StreamConfigMap,
  TProcedures extends ProcedureConfigMap,
> = StreamDefsFromConfig<TStreams> & ProcedureDefsFromConfig<TProcedures>
