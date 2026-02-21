import {
  recallInputSchema,
  recallResultSchema,
  reflectInputSchema,
  reflectResultSchema,
  retainBatchInputSchema,
  retainBatchOutputSchema,
  retainInputSchema,
  retainResultSchema,
} from "@ellie/schemas/hindsight"
import { defineProcedures } from "../types"

export const coreOperationProcedureDefs = defineProcedures({
  retain: {
    method: `POST`,
    path: `/banks/:bankId/retain`,
    input: retainInputSchema,
    output: retainResultSchema,
  },
  retainBatch: {
    method: `POST`,
    path: `/banks/:bankId/retain-batch`,
    input: retainBatchInputSchema,
    output: retainBatchOutputSchema,
  },
  recall: {
    method: `POST`,
    path: `/banks/:bankId/recall`,
    input: recallInputSchema,
    output: recallResultSchema,
  },
  reflect: {
    method: `POST`,
    path: `/banks/:bankId/reflect`,
    input: reflectInputSchema,
    output: reflectResultSchema,
  },
} as const)
