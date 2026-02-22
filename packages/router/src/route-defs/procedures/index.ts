import { defineProcedures } from "../types"
import { agentActionProcedureDefs } from "./agent-actions"
import { bankCrudProcedureDefs } from "./bank-crud"
import { coreOperationProcedureDefs } from "./core-operations"
import { episodeProcedureDefs } from "./episode-operations"
import { memoryAndEntityProcedureDefs } from "./memory-entities"

export const procedureDefs = defineProcedures({
  ...agentActionProcedureDefs,
  ...bankCrudProcedureDefs,
  ...coreOperationProcedureDefs,
  ...episodeProcedureDefs,
  ...memoryAndEntityProcedureDefs,
} as const)
