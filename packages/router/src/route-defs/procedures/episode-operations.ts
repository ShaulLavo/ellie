import {
  listEpisodesInputSchema,
  listEpisodesResultSchema,
  narrativeInputSchema,
  narrativeResultSchema,
} from "@ellie/schemas/hindsight"
import { defineProcedures } from "../types"

export const episodeProcedureDefs = defineProcedures({
  listEpisodes: {
    method: `GET`,
    path: `/banks/:bankId/episodes`,
    input: listEpisodesInputSchema,
    output: listEpisodesResultSchema,
  },
  narrative: {
    method: `POST`,
    path: `/banks/:bankId/narrative`,
    input: narrativeInputSchema,
    output: narrativeResultSchema,
  },
} as const)
