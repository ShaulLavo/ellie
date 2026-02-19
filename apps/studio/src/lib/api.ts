import { treaty } from "@elysiajs/eden";
import type { App } from "../../../app/src/server";

export const api = treaty<App>("/");
