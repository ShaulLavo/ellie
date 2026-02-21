import { defineProcedures } from "../types"
import { agentActionProcedureDefs } from "./agent-actions"
import { bankCrudProcedureDefs } from "./bank-crud"
import { coreOperationProcedureDefs } from "./core-operations"
import { memoryAndEntityProcedureDefs } from "./memory-entities"

export const procedureDefs = defineProcedures({
  ...agentActionProcedureDefs,
  ...bankCrudProcedureDefs,
  ...coreOperationProcedureDefs,
  ...memoryAndEntityProcedureDefs,
} as const)
