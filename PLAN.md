Approach

I’d treat this as a refactor, not a patch series: split the WhatsApp code in apps/server/src/channels/providers/whatsapp/provider.ts:94 into smaller inbound/access-control/outbound modules so Ellie can actually match OpenCLAW behavior instead of accreting more logic into one file.
I’d use /Users/shaul/Desktop/ai/pa/claw/openclaw/src/web/inbound/monitor.ts:25, /Users/shaul/Desktop/ai/pa/claw/openclaw/src/web/inbound/access-control.ts:20, /Users/shaul/Desktop/ai/pa/claw/openclaw/src/whatsapp/resolve-outbound-target.ts:9, and /Users/shaul/Desktop/ai/pa/claw/openclaw/extensions/whatsapp/src/channel.ts:122 as the parity baseline.
Plan

Phase 1 — fix correctness blockers first in apps/server/src/channels/providers/whatsapp/provider.ts:599, apps/server/src/channels/core/manager.ts:154, apps/server/src/channels/providers/whatsapp/formatting.ts:64, and apps/server/src/channels/providers/whatsapp/normalize.ts:92.
Phase 1 tasks — use msg.key.participant for group sender identity, keep remoteJid as conversationId, preserve WhatsApp timestamps, dedupe by WhatsApp message id instead of 2s content hash, replace chunkMessage() with hard-break chunking, and widen JID/LID handling.
Phase 2 — extract DM and group access control into a dedicated module modeled on /Users/shaul/Desktop/ai/pa/claw/openclaw/src/web/inbound/access-control.ts:20.
Phase 2 tasks — add dmPolicy: pairing|allowlist|open|disabled, require allowFrom: ["*"] for open, default unconfigured DMs to self-only, add pairing-request persistence/approval flow, add pairing grace for historical messages, and suppress read receipts/pairing side effects in self-chat mode.
Phase 3 — port group parity into apps/server/src/channels/providers/whatsapp/provider.ts:54 and related settings code: add groupPolicy: allowlist|open|disabled, groupAllowFrom, per-group requireMention, and proper mention/reply-to-self detection.
Phase 3 tasks — support “store as context but do not trigger” for unmentioned group traffic, which likely requires a small ChannelManager/history refactor around apps/server/src/channels/core/manager.ts:154.
Phase 4 — port inbound feature parity from /Users/shaul/Desktop/ai/pa/claw/openclaw/src/web/inbound/monitor.ts:154 and /Users/shaul/Desktop/ai/pa/claw/openclaw/src/web/inbound/extract.ts:87: handle append vs notify, configurable read receipts, debounce, media download, quoted-message context, locations, contacts, mentions, and fold audio STT into that pipeline.
Phase 5 — port outbound/runtime parity: add target normalization, media sends, polls, reactions, richer runtime status, self-id reporting, reconnect telemetry, and heartbeat readiness, likely extending apps/server/src/channels/core/provider.ts:12.
Phase 6 — align onboarding and config in apps/cli/cmd/ellie/cmd_auth.go:520 so CLI choices produce valid OpenCLAW-style settings, then add schema/runtime validation for the expanded WhatsApp settings surface.
Phase 7 — add regression coverage by porting the OpenCLAW-style tests for access control, inbound monitor behavior, outbound target resolution, chunking, and status; finish by running bun test and oxfmt on the TS files.
Suggested PR Order

PR 1 — module split + correctness blockers.
PR 2 — DM/group access-control parity.
PR 3 — inbound media/mention/history behavior.
PR 4 — outbound/status/CLI parity + regression suite.
