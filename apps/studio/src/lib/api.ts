import { treaty } from "@elysiajs/eden";
import type { App } from "@ellie/api-types";

export const api = treaty<App>("/");
