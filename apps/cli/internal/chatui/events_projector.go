package chatui

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Renderable event types that produce chat messages.
var renderableTypes = map[string]bool{
	"user_message":      true,
	"assistant_message": true,
	"tool_execution":    true,
	"memory_recall":     true,
	"memory_retain":     true,
	"error":             true,
}

// Agent lifecycle event types.
var agentStartTypes = map[string]bool{"agent_start": true}
var agentEndTypes = map[string]bool{"agent_end": true, "run_closed": true}

// IsRenderable returns true if the event type produces a chat message.
func IsRenderable(eventType string) bool {
	return renderableTypes[eventType]
}

// IsAgentStart returns true if the event signals agent run start.
func IsAgentStart(eventType string) bool {
	return agentStartTypes[eventType]
}

// IsAgentEnd returns true if the event signals agent run end.
func IsAgentEnd(eventType string) bool {
	return agentEndTypes[eventType]
}

// IsAgentRunOpen checks if the last agent lifecycle event was a start.
func IsAgentRunOpen(rows []EventRow) bool {
	open := false
	for _, row := range rows {
		if agentStartTypes[row.Type] {
			open = true
		}
		if agentEndTypes[row.Type] {
			open = false
		}
	}
	return open
}

// EventToStored converts an EventRow into a StoredMessage.
// This mirrors the FE eventToStored function.
func EventToStored(row EventRow) StoredMessage {
	parsed := parsePayload(row.Payload)

	var parts []ContentPart

	switch row.Type {
	case "assistant_message":
		msg := jsonObj(parsed, "message")
		parts = extractMessageParts(msg)

	case "tool_execution":
		status := jsonStr(parsed, "status")
		if status == "complete" || status == "error" {
			resultObj := jsonObj(parsed, "result")
			parts = extractToolResultParts(map[string]interface{}{
				"toolName":   parsed["toolName"],
				"toolCallId": parsed["toolCallId"],
				"content":    resultObj["content"],
			})
		} else {
			parts = extractToolCallParts(parsed)
		}

	case "memory_recall", "memory_retain":
		parts = extractMemoryParts(parsed)

	case "error":
		parts = extractErrorParts(parsed)

	default:
		parts = extractMessageParts(parsed)
	}

	// Extract text from text parts
	var textParts []string
	for _, p := range parts {
		if p.Type == PartText {
			textParts = append(textParts, p.Text)
		}
	}
	text := strings.Join(textParts, "\n")

	// Extract thinking from thinking parts
	var thinkingParts []string
	for _, p := range parts {
		if p.Type == PartThinking {
			thinkingParts = append(thinkingParts, p.Text)
		}
	}
	thinking := strings.Join(thinkingParts, "\n")

	// Filter out thinking and toolCall parts
	filtered := make([]ContentPart, 0, len(parts))
	for _, p := range parts {
		if p.Type == PartThinking {
			continue
		}
		// Skip agent-internal camelCase "toolCall" format
		if string(p.Type) == "toolCall" {
			continue
		}
		filtered = append(filtered, p)
	}

	// Determine sender
	sender := resolveSender(row.Type, parsed)

	ts := time.UnixMilli(row.CreatedAt).UTC().Format(time.RFC3339)

	return StoredMessage{
		ID:        fmt.Sprintf("%d", row.ID),
		Timestamp: ts,
		Text:      text,
		Parts:     filtered,
		Seq:       row.Seq,
		Sender:    sender,
		Thinking:  thinking,
	}
}

// ComputeStatsFromEvents aggregates session stats from raw events.
func ComputeStatsFromEvents(events []EventRow) SessionStats {
	var stats SessionStats
	for _, ev := range events {
		switch ev.Type {
		case "user_message":
			stats.MessageCount++

		case "assistant_message":
			parsed := parsePayload(ev.Payload)
			if b, ok := parsed["streaming"].(bool); ok && b {
				continue // skip in-flight
			}
			stats.MessageCount++
			msg := jsonObj(parsed, "message")
			if m, ok := msg["model"].(string); ok {
				stats.Model = &m
			}
			if p, ok := msg["provider"].(string); ok {
				stats.Provider = &p
			}
			if usage, ok := msg["usage"].(map[string]interface{}); ok {
				if v, ok := usage["input"].(float64); ok {
					stats.PromptTokens += int(v)
				}
				if v, ok := usage["output"].(float64); ok {
					stats.CompletionTokens += int(v)
				}
				if cost, ok := usage["cost"].(map[string]interface{}); ok {
					if v, ok := cost["total"].(float64); ok {
						stats.TotalCost += v
					}
				}
			}
		}
	}
	return stats
}

// MergeStats adds delta stats into prev, preferring non-nil model/provider from delta.
func MergeStats(prev, delta SessionStats) SessionStats {
	out := prev
	if delta.Model != nil {
		out.Model = delta.Model
	}
	if delta.Provider != nil {
		out.Provider = delta.Provider
	}
	out.MessageCount += delta.MessageCount
	out.PromptTokens += delta.PromptTokens
	out.CompletionTokens += delta.CompletionTokens
	out.TotalCost += delta.TotalCost
	return out
}

// --- helpers ---

func parsePayload(raw json.RawMessage) map[string]interface{} {
	var out map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]interface{}{}
	}
	return out
}

func jsonObj(m map[string]interface{}, key string) map[string]interface{} {
	if v, ok := m[key].(map[string]interface{}); ok {
		return v
	}
	return map[string]interface{}{}
}

func jsonStr(m map[string]interface{}, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func extractMessageParts(parsed map[string]interface{}) []ContentPart {
	// Check content array
	if arr, ok := parsed["content"].([]interface{}); ok {
		return parseContentArray(arr)
	}
	// Check parts array
	if arr, ok := parsed["parts"].([]interface{}); ok {
		return parseContentArray(arr)
	}
	// Check content string
	if s, ok := parsed["content"].(string); ok && s != "" {
		return []ContentPart{{Type: PartText, Text: s}}
	}
	// Surface API errors
	if parsed["stopReason"] == "error" {
		if msg, ok := parsed["errorMessage"].(string); ok {
			return []ContentPart{{Type: PartText, Text: "Error: " + msg}}
		}
	}
	return nil
}

func extractToolResultParts(parsed map[string]interface{}) []ContentPart {
	var resultContent string
	if arr, ok := parsed["content"].([]interface{}); ok {
		for _, item := range arr {
			if m, ok := item.(map[string]interface{}); ok {
				if m["type"] == "text" {
					if t, ok := m["text"].(string); ok {
						resultContent += t
					}
				}
			}
		}
	}
	return []ContentPart{{
		Type:       PartToolResult,
		ToolName:   jsonStr(parsed, "toolName"),
		ToolCallID: jsonStr(parsed, "toolCallId"),
		Result:     resultContent,
	}}
}

func extractToolCallParts(parsed map[string]interface{}) []ContentPart {
	args := map[string]interface{}{}
	if a, ok := parsed["args"].(map[string]interface{}); ok {
		args = a
	}
	return []ContentPart{{
		Type:       PartToolCall,
		Name:       jsonStr(parsed, "toolName"),
		Args:       args,
		ToolCallID: jsonStr(parsed, "toolCallId"),
	}}
}

func extractMemoryParts(parsed map[string]interface{}) []ContentPart {
	if arr, ok := parsed["parts"].([]interface{}); ok {
		return parseContentArray(arr)
	}
	return nil
}

func extractErrorParts(parsed map[string]interface{}) []ContentPart {
	msg := "An unexpected error occurred"
	if s, ok := parsed["message"].(string); ok {
		msg = s
	}
	return []ContentPart{{Type: PartText, Text: msg}}
}

func resolveSender(eventType string, parsed map[string]interface{}) MessageSender {
	role := jsonStr(parsed, "role")
	switch {
	case eventType == "user_message" || role == "user":
		return SenderUser
	case eventType == "assistant_message" || role == "assistant":
		return SenderAgent
	case role == "system":
		return SenderSystem
	case eventType == "error":
		return SenderAgent
	case len(eventType) > 5 && eventType[:5] == "tool_":
		return SenderAgent
	case len(eventType) > 7 && eventType[:7] == "memory_":
		return SenderMemory
	default:
		return ""
	}
}

func parseContentArray(arr []interface{}) []ContentPart {
	parts := make([]ContentPart, 0, len(arr))
	for _, item := range arr {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		raw, _ := json.Marshal(m)
		var p ContentPart
		if err := json.Unmarshal(raw, &p); err != nil {
			continue
		}
		if p.Type == "" {
			continue
		}
		parts = append(parts, p)
	}
	return parts
}
