-- Migration 120: admit the native 'pi' provider runtimes on sessions.agent_runtime
-- and workflow_runs.agent_runtime.

-- ---------------------------------------------------------------------------
-- sessions.agent_runtime  (119 list + 'pi-sdk' + 'pi-pty')
--
-- pi-pty IS admitted on sessions, exactly as omp-pty/codex-pty are: a quick
-- terminal session is a first-class chat session. The workflow_runs list below
-- stays narrower.
-- ---------------------------------------------------------------------------

ALTER TABLE sessions ADD COLUMN agent_runtime_widen_120 TEXT;
UPDATE sessions SET agent_runtime_widen_120 = agent_runtime;
ALTER TABLE sessions DROP COLUMN agent_runtime;
ALTER TABLE sessions
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','codex-pty','omp-sdk','omp-pty','omp-fleet','pi-sdk','pi-pty'));
UPDATE sessions SET agent_runtime = COALESCE(agent_runtime_widen_120, 'claude-sdk');
ALTER TABLE sessions DROP COLUMN agent_runtime_widen_120;

-- ---------------------------------------------------------------------------
-- workflow_runs.agent_runtime  (119 list + 'pi-sdk')
--
-- pi-pty stays absent for the same reason codex-pty/omp-pty are: a workflow run
-- needs structured events, usage and review-queue integration, which a TUI
-- driven by keystrokes cannot supply. pi-sdk qualifies (pi --mode json).
-- ---------------------------------------------------------------------------

ALTER TABLE workflow_runs ADD COLUMN agent_runtime_widen_120 TEXT;
UPDATE workflow_runs SET agent_runtime_widen_120 = agent_runtime;
ALTER TABLE workflow_runs DROP COLUMN agent_runtime;
ALTER TABLE workflow_runs
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','omp-sdk','omp-fleet','pi-sdk'));
UPDATE workflow_runs SET agent_runtime = COALESCE(agent_runtime_widen_120, 'claude-sdk');
ALTER TABLE workflow_runs DROP COLUMN agent_runtime_widen_120;
