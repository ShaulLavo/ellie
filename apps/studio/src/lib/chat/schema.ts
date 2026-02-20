import { createStateSchema } from "@ellie/streams-state";
import * as v from "valibot";

export const messageSchema = v.object({
  id: v.string(),
  role: v.picklist(["user", "assistant", "system"]),
  content: v.string(),
  createdAt: v.string(),
});

export const chatStateSchema = createStateSchema({
  messages: {
    schema: messageSchema,
    type: "message",
    primaryKey: "id",
  },
});

export type Message = v.InferOutput<typeof messageSchema>;
