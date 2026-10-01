// Meetings — turn-based multi-agent debates held in the Office. See
// server/internal/service/meeting.go for the engine.

export type MeetingType =
  | "issue_discussion"
  | "standup"
  | "planning"
  | "retro"
  | "general";

export type MeetingStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "failed";

export type MeetingAuthorType = "agent" | "member" | "system";

export interface MeetingParticipant {
  id: string;
  agent_id: string;
  speaking_order: number;
}

export interface MeetingMessage {
  id: string;
  seq: number;
  round: number;
  author_type: MeetingAuthorType;
  /** Agent or member id; absent for system messages. */
  author_id?: string;
  content: string;
  created_at: string;
}

export interface Meeting {
  id: string;
  workspace_id: string;
  title: string;
  type: MeetingType;
  topic: string;
  /** Set when the meeting is about a specific issue. */
  issue_id?: string;
  status: MeetingStatus;
  rounds: number;
  current_round: number;
  current_turn: number;
  summary: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  participants: MeetingParticipant[];
  messages: MeetingMessage[];
}

export interface CreateMeetingRequest {
  title: string;
  type: MeetingType;
  topic?: string;
  issue_id?: string;
  rounds?: number;
  agent_ids: string[];
}
