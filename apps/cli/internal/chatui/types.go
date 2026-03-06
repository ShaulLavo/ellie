package chatui

import "encoding/json"

// ConnectionState mirrors FE ConnectionState.
type ConnectionState string

const (
	StateDisconnected ConnectionState = "disconnected"
	StateConnecting   ConnectionState = "connecting"
	StateConnected    ConnectionState = "connected"
	StateError        ConnectionState = "error"
)

// MessageSender mirrors FE MessageSender.
type MessageSender string

const (
	SenderUser   MessageSender = "user"
	SenderAgent  MessageSender = "agent"
	SenderSystem MessageSender = "system"
	SenderMemory MessageSender = "memory"
	SenderHuman  MessageSender = "human"
)

// ContentPartType enumerates the content part types we render.
type ContentPartType string

const (
	PartText         ContentPartType = "text"
	PartToolCall     ContentPartType = "tool-call"
	PartToolResult   ContentPartType = "tool-result"
	PartMemory       ContentPartType = "memory"
	PartMemoryRetain ContentPartType = "memory-retain"
	PartThinking     ContentPartType = "thinking"
	PartArtifact     ContentPartType = "artifact"
	PartImage        ContentPartType = "image"
	PartVideo        ContentPartType = "video"
	PartAudio        ContentPartType = "audio"
	PartFile         ContentPartType = "file"
)

// ContentPart is a union type for renderable content parts.
// We use a single struct with optional fields rather than interfaces
// to keep serialization/deserialization simple.
type ContentPart struct {
	Type ContentPartType `json:"type"`

	// text
	Text string `json:"text,omitempty"`

	// tool-call
	Name       string                 `json:"name,omitempty"`
	Args       map[string]interface{} `json:"args,omitempty"`
	ToolCallID string                 `json:"toolCallId,omitempty"`
	Streaming  bool                   `json:"streaming,omitempty"`

	// tool-result
	Result   string `json:"result,omitempty"`
	ToolName string `json:"toolName,omitempty"`

	// memory
	Count      int          `json:"count,omitempty"`
	Memories   []MemoryItem `json:"memories,omitempty"`
	DurationMs int          `json:"duration_ms,omitempty"`

	// memory-retain
	FactsStored int      `json:"factsStored,omitempty"`
	Facts       []string `json:"facts,omitempty"`
	Model       string   `json:"model,omitempty"`

	// artifact
	ArtifactType string `json:"artifactType,omitempty"`
	Content      string `json:"content,omitempty"`
	Filename     string `json:"filename,omitempty"`
	Title        string `json:"title,omitempty"`

	// image/video/audio/file
	File string `json:"file,omitempty"`
	Mime string `json:"mime,omitempty"`
	Size int    `json:"size,omitempty"`
}

// MemoryItem is a recalled memory fact.
type MemoryItem struct {
	Text  string `json:"text"`
	Model string `json:"model,omitempty"`
}

// StoredMessage is the client-side projected chat message (mirrors FE StoredChatMessage).
type StoredMessage struct {
	ID          string        `json:"id"`
	Timestamp   string        `json:"timestamp"`
	Text        string        `json:"text"`
	Parts       []ContentPart `json:"parts"`
	Seq         int           `json:"seq"`
	Sender      MessageSender `json:"sender,omitempty"`
	Thinking    string        `json:"thinking,omitempty"`
	IsStreaming bool          `json:"isStreaming,omitempty"`
}

// EventRow mirrors FE EventRow from the SSE stream.
type EventRow struct {
	ID        int             `json:"id"`
	SessionID string          `json:"sessionId"`
	Seq       int             `json:"seq"`
	RunID     *string         `json:"runId"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	DedupeKey *string         `json:"dedupeKey"`
	CreatedAt int64           `json:"createdAt"`
}

// SessionStats mirrors FE SessionStats.
type SessionStats struct {
	Model            *string `json:"model"`
	Provider         *string `json:"provider"`
	MessageCount     int     `json:"messageCount"`
	PromptTokens     int     `json:"promptTokens"`
	CompletionTokens int     `json:"completionTokens"`
	TotalCost        float64 `json:"totalCost"`
}

// SessionEntry is a summary of a chat session.
type SessionEntry struct {
	ID         string `json:"id"`
	CurrentSeq int    `json:"currentSeq"`
	CreatedAt  int64  `json:"createdAt"`
	UpdatedAt  int64  `json:"updatedAt"`
}

// StatusResponse is the /api/status response shape.
type StatusResponse struct {
	ConnectedClients int  `json:"connectedClients"`
	NeedsBootstrap   bool `json:"needsBootstrap"`
}

// DialogKind identifies which dialog is active.
type DialogKind int

const (
	DialogNone DialogKind = iota
	DialogCommands
	DialogSessions
	DialogSessionInfo
	DialogClearConfirm
)

// SlashCommand defines a chat command.
type SlashCommand struct {
	Name        string
	Description string
}

var Commands = []SlashCommand{
	{Name: "clear", Description: "Start a new conversation"},
	{Name: "sessions", Description: "List all sessions"},
	{Name: "info", Description: "Show current session info"},
	{Name: "transcript", Description: "Save session transcript"},
}
