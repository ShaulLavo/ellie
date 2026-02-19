import { createStateSchema } from "@durable-streams/state";
import { z } from "zod";

export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string(),
});

export const chatStateSchema = createStateSchema({
  messages: {
    schema: messageSchema,
    type: "message",
    primaryKey: "id",
  },
});

export type Message = z.infer<typeof messageSchema>;
