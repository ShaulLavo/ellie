import {
  bankSchema,
  createBankInputSchema,
  listBanksOutputSchema,
  updateBankInputSchema,
  voidSchema,
} from "@ellie/schemas/hindsight"
import { defineProcedures } from "../types"

export const bankCrudProcedureDefs = defineProcedures({
  createBank: {
    method: `POST`,
    path: `/banks`,
    input: createBankInputSchema,
    output: bankSchema,
  },
  listBanks: {
    method: `GET`,
    path: `/banks`,
    input: voidSchema,
    output: listBanksOutputSchema,
  },
  getBank: {
    method: `GET`,
    path: `/banks/:bankId`,
    input: voidSchema,
    output: bankSchema,
  },
  updateBank: {
    method: `PATCH`,
    path: `/banks/:bankId`,
    input: updateBankInputSchema,
    output: bankSchema,
  },
  deleteBank: {
    method: `DELETE`,
    path: `/banks/:bankId`,
    input: voidSchema,
    output: voidSchema,
  },
} as const)
