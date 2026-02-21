import {
  bankStatsSchema,
  deleteMemoryUnitResultSchema,
  entityDetailSchema,
  listEntitiesInputSchema,
  listEntitiesResultSchema,
  listMemoryUnitsInputSchema,
  listMemoryUnitsResultSchema,
  memoryUnitDetailSchema,
  voidSchema,
} from "@ellie/schemas/hindsight"
import { defineProcedures } from "../types"

export const memoryAndEntityProcedureDefs = defineProcedures({
  getBankStats: {
    method: `GET`,
    path: `/banks/:bankId/stats`,
    input: voidSchema,
    output: bankStatsSchema,
  },
  listMemoryUnits: {
    method: `GET`,
    path: `/banks/:bankId/memories`,
    input: listMemoryUnitsInputSchema,
    output: listMemoryUnitsResultSchema,
  },
  getMemoryUnit: {
    method: `GET`,
    path: `/banks/:bankId/memories/:memoryId`,
    input: voidSchema,
    output: memoryUnitDetailSchema,
  },
  deleteMemoryUnit: {
    method: `DELETE`,
    path: `/banks/:bankId/memories/:memoryId`,
    input: voidSchema,
    output: deleteMemoryUnitResultSchema,
  },
  listEntities: {
    method: `GET`,
    path: `/banks/:bankId/entities`,
    input: listEntitiesInputSchema,
    output: listEntitiesResultSchema,
  },
  getEntity: {
    method: `GET`,
    path: `/banks/:bankId/entities/:entityId`,
    input: voidSchema,
    output: entityDetailSchema,
  },
} as const)
