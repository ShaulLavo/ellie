package chatui

// ToolGrouping holds computed tool-call/result pairing data,
// mirroring the FE useToolGrouping hook.
type ToolGrouping struct {
	// ToolResults maps toolCallId → ToolResult content part.
	ToolResults map[string]ContentPart

	// ConsumedToolCallIDs are tool-call IDs that have a matching result.
	ConsumedToolCallIDs map[string]bool

	// HiddenMessageIDs are messages that contain only a single tool-result
	// that is already consumed (represented inline with its tool-call).
	HiddenMessageIDs map[string]bool
}

// ComputeToolGrouping processes messages and computes grouping data.
func ComputeToolGrouping(messages []StoredMessage, streaming *StoredMessage) ToolGrouping {
	all := messages
	if streaming != nil {
		all = append(append([]StoredMessage{}, messages...), *streaming)
	}

	tg := ToolGrouping{
		ToolResults:         make(map[string]ContentPart),
		ConsumedToolCallIDs: make(map[string]bool),
		HiddenMessageIDs:    make(map[string]bool),
	}

	// Build tool results map: toolCallId → tool-result part
	for _, msg := range all {
		for _, part := range msg.Parts {
			if part.Type != PartToolResult || part.ToolCallID == "" {
				continue
			}
			tg.ToolResults[part.ToolCallID] = part
		}
	}

	// Collect non-streaming tool-call IDs (from tool_execution events)
	executingIDs := make(map[string]bool)
	for _, msg := range all {
		for _, part := range msg.Parts {
			if part.Type == PartToolCall && part.ToolCallID != "" && !part.Streaming {
				executingIDs[part.ToolCallID] = true
			}
		}
	}

	// Find consumed tool-call IDs:
	// - tool-calls that have matching results
	// - streaming tool-calls superseded by a real execution
	for _, msg := range all {
		for _, part := range msg.Parts {
			if part.Type != PartToolCall || part.ToolCallID == "" {
				continue
			}
			if _, ok := tg.ToolResults[part.ToolCallID]; ok {
				tg.ConsumedToolCallIDs[part.ToolCallID] = true
			}
			if part.Streaming && executingIDs[part.ToolCallID] {
				tg.ConsumedToolCallIDs[part.ToolCallID] = true
			}
		}
	}

	// Find hidden messages: single-part tool-result messages where
	// the result is already consumed inline
	for _, msg := range all {
		if len(msg.Parts) != 1 || msg.Parts[0].Type != PartToolResult {
			continue
		}
		if id := msg.Parts[0].ToolCallID; id != "" && tg.ConsumedToolCallIDs[id] {
			tg.HiddenMessageIDs[msg.ID] = true
		}
	}

	return tg
}
