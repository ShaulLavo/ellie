package chatui

import "testing"

func TestComputeToolGrouping_Basic(t *testing.T) {
	messages := []StoredMessage{
		{
			ID: "msg-1",
			Parts: []ContentPart{
				{Type: PartToolCall, Name: "read_file", ToolCallID: "tc-1"},
			},
			Sender: SenderAgent,
		},
		{
			ID: "msg-2",
			Parts: []ContentPart{
				{Type: PartToolResult, ToolCallID: "tc-1", ToolName: "read_file", Result: "content"},
			},
			Sender: SenderAgent,
		},
	}

	tg := ComputeToolGrouping(messages, nil)

	// tc-1 should be in tool results
	if _, ok := tg.ToolResults["tc-1"]; !ok {
		t.Error("expected tc-1 in ToolResults")
	}

	// tc-1 should be consumed
	if !tg.ConsumedToolCallIDs["tc-1"] {
		t.Error("expected tc-1 in ConsumedToolCallIDs")
	}

	// msg-2 should be hidden (single-part tool-result with consumed ID)
	if !tg.HiddenMessageIDs["msg-2"] {
		t.Error("expected msg-2 in HiddenMessageIDs")
	}

	// msg-1 should NOT be hidden
	if tg.HiddenMessageIDs["msg-1"] {
		t.Error("msg-1 should not be hidden")
	}
}

func TestComputeToolGrouping_NoMatchingResult(t *testing.T) {
	messages := []StoredMessage{
		{
			ID: "msg-1",
			Parts: []ContentPart{
				{Type: PartToolCall, Name: "read_file", ToolCallID: "tc-1"},
			},
		},
	}

	tg := ComputeToolGrouping(messages, nil)

	if tg.ConsumedToolCallIDs["tc-1"] {
		t.Error("tc-1 should not be consumed without a matching result")
	}
}

func TestComputeToolGrouping_MultiPartMessage(t *testing.T) {
	// A message with multiple parts including a tool-result should NOT be hidden
	messages := []StoredMessage{
		{
			ID: "msg-1",
			Parts: []ContentPart{
				{Type: PartToolCall, Name: "read_file", ToolCallID: "tc-1"},
			},
		},
		{
			ID: "msg-2",
			Parts: []ContentPart{
				{Type: PartText, Text: "Some text"},
				{Type: PartToolResult, ToolCallID: "tc-1", Result: "result"},
			},
		},
	}

	tg := ComputeToolGrouping(messages, nil)

	// msg-2 should NOT be hidden because it has multiple parts
	if tg.HiddenMessageIDs["msg-2"] {
		t.Error("msg-2 should not be hidden when it has multiple parts")
	}
}

func TestComputeToolGrouping_WithStreaming(t *testing.T) {
	messages := []StoredMessage{
		{
			ID: "msg-1",
			Parts: []ContentPart{
				{Type: PartToolCall, Name: "read_file", ToolCallID: "tc-1"},
			},
		},
	}

	streaming := &StoredMessage{
		ID: "msg-stream",
		Parts: []ContentPart{
			{Type: PartToolResult, ToolCallID: "tc-1", Result: "streaming result"},
		},
	}

	tg := ComputeToolGrouping(messages, streaming)

	if !tg.ConsumedToolCallIDs["tc-1"] {
		t.Error("tc-1 should be consumed when streaming message has result")
	}
}

func TestComputeToolGrouping_Empty(t *testing.T) {
	tg := ComputeToolGrouping(nil, nil)

	if len(tg.ToolResults) != 0 {
		t.Error("expected empty ToolResults")
	}
	if len(tg.ConsumedToolCallIDs) != 0 {
		t.Error("expected empty ConsumedToolCallIDs")
	}
	if len(tg.HiddenMessageIDs) != 0 {
		t.Error("expected empty HiddenMessageIDs")
	}
}
