-- name: CreateMeeting :one
INSERT INTO meeting (workspace_id, title, type, topic, issue_id, rounds, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: GetMeeting :one
SELECT * FROM meeting WHERE id = $1;

-- name: GetMeetingInWorkspace :one
SELECT * FROM meeting WHERE id = $1 AND workspace_id = $2;

-- name: ListMeetings :many
SELECT * FROM meeting
WHERE workspace_id = $1
ORDER BY created_at DESC
LIMIT 100;

-- name: StartMeeting :one
UPDATE meeting
SET status = 'in_progress', started_at = NOW(), current_round = 1, current_turn = 0, updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: UpdateMeetingProgress :one
UPDATE meeting
SET current_round = $2, current_turn = $3, status = $4, updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: CompleteMeeting :one
UPDATE meeting
SET status = 'completed', completed_at = NOW(), summary = $2, updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: FailMeeting :one
UPDATE meeting
SET status = 'failed', completed_at = NOW(), updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: CancelMeeting :one
UPDATE meeting
SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: AddMeetingParticipant :one
INSERT INTO meeting_participant (meeting_id, agent_id, speaking_order)
VALUES ($1, $2, $3)
RETURNING *;

-- name: ListMeetingParticipants :many
SELECT * FROM meeting_participant
WHERE meeting_id = $1
ORDER BY speaking_order ASC, created_at ASC;

-- name: AddMeetingMessage :one
INSERT INTO meeting_message (meeting_id, seq, round, author_type, author_id, content)
VALUES (
    $1,
    COALESCE((SELECT MAX(seq) FROM meeting_message WHERE meeting_id = $1), 0) + 1,
    $2, $3, $4, $5
)
RETURNING *;

-- name: ListMeetingMessages :many
SELECT * FROM meeting_message
WHERE meeting_id = $1
ORDER BY seq ASC;

-- name: CreateMeetingTurn :one
INSERT INTO meeting_turn (meeting_id, task_id, agent_id, round, turn_index)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetMeetingTurnByTask :one
SELECT * FROM meeting_turn WHERE task_id = $1;

-- name: UpdateMeetingTurnStatus :exec
UPDATE meeting_turn SET status = $2 WHERE id = $1;
