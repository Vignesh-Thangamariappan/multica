-- Meetings: turn-based multi-agent debates held in the Office.
--
-- A meeting gathers participating agents who take turns responding to a topic
-- over a number of rounds. Each turn runs as an agent task; its output lands in
-- meeting_message, building a transcript. When all rounds finish a summary is
-- produced. v1 covers issue_discussion + standup; the schema is type-agnostic
-- so planning/retro slot in later.

CREATE TABLE IF NOT EXISTS meeting (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    -- 'issue_discussion' | 'standup' | 'planning' | 'retro' | 'general'
    type            TEXT NOT NULL DEFAULT 'issue_discussion',
    -- agenda / prompt that frames the debate
    topic           TEXT NOT NULL DEFAULT '',
    -- optional issue the meeting is about (issue_discussion)
    issue_id        UUID REFERENCES issue(id) ON DELETE SET NULL,
    -- 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'failed'
    status          TEXT NOT NULL DEFAULT 'scheduled',
    rounds          INT  NOT NULL DEFAULT 2,
    current_round   INT  NOT NULL DEFAULT 0,
    -- index into the participant speaking order for the active turn
    current_turn    INT  NOT NULL DEFAULT 0,
    summary         TEXT NOT NULL DEFAULT '',
    created_by      UUID REFERENCES "user"(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_workspace ON meeting(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_status ON meeting(workspace_id, status);

-- Ordered agent participants. speaking_order defines the round-robin turn order.
CREATE TABLE IF NOT EXISTS meeting_participant (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id      UUID NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    speaking_order  INT  NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (meeting_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_participant ON meeting_participant(meeting_id, speaking_order);

-- Transcript: one row per turn (agent), per human note, or per system marker.
CREATE TABLE IF NOT EXISTS meeting_message (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id      UUID NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
    seq             INT  NOT NULL,
    round           INT  NOT NULL DEFAULT 0,
    author_type     TEXT NOT NULL,          -- 'agent' | 'member' | 'system'
    author_id       UUID,                   -- agent/member id; NULL for system
    content         TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (meeting_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_meeting_message ON meeting_message(meeting_id, seq);

-- Maps a debate-turn agent task back to its meeting so task completion can
-- append the agent's reply to the transcript and advance to the next turn.
-- Kept out of agent_task_queue to avoid touching that hot table.
CREATE TABLE IF NOT EXISTS meeting_turn (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id      UUID NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
    task_id         UUID NOT NULL REFERENCES agent_task_queue(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    round           INT  NOT NULL,
    turn_index      INT  NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'done' | 'failed'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (task_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_turn_meeting ON meeting_turn(meeting_id);
