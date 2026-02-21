import { defineProcedures } from "../types"
import { bankCrudProcedureDefs } from "./bank-crud"
import { coreOperationProcedureDefs } from "./core-operations"
import { memoryAndEntityProcedureDefs } from "./memory-entities"

export const procedureDefs = defineProcedures({
  ...bankCrudProcedureDefs,
  ...coreOperationProcedureDefs,
  ...memoryAndEntityProcedureDefs,
} as const)
