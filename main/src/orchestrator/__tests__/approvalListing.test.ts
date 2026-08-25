/**
 * Unit tests for selectPendingApprovals (approvalListing).
 *
 * Five cases:
 *  1. empty table returns []
 *  2. orders by created_at ASC (oldest first)
 *  3. truncates payloadPreview to 512 chars
 *  4. resolves workflowName via JOIN to workflows.name
 *  5. excludes non-pending statuses (approved, rejected, expired, timed_out)
 *
 * All tests use an in-memory better-sqlite3 instance via createTestDb.
 */
import { describe, it, expect } from 'vitest';
import { selectPendingApprovals, toApprovalAttribution } from '../approvalListing';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun, seedApproval } from '../__test_fixtures__/orchestratorTestDb';

describe('selectPendingApprovals', () => {
  // -------------------------------------------------------------------------
  // Case 1: empty table returns []
  // -------------------------------------------------------------------------
  it('returns [] when the approvals table is empty', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);

    const result = selectPendingApprovals(adapter);
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Case 2: orders by created_at ASC
  // -------------------------------------------------------------------------
  it('orders rows by created_at ASC (oldest first)', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);

    seedRun(db, { id: 'run-ord-1' });
    seedRun(db, { id: 'run-ord-2' });

    // Insert newer first so insertion order differs from expected ORDER BY result.
    const newerAt = '2026-01-01T00:00:02Z';
    const olderAt = '2026-01-01T00:00:01Z';
    seedApproval(db, { id: 'approval-newer', runId: 'run-ord-1', toolName: 'Bash', toolInputJson: '{}', createdAt: newerAt });
    seedApproval(db, { id: 'approval-older', runId: 'run-ord-2', toolName: 'Bash', toolInputJson: '{}', createdAt: olderAt });

    const result = selectPendingApprovals(adapter);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('approval-older');
    expect(result[1].id).toBe('approval-newer');
  });

  // -------------------------------------------------------------------------
  // Case 3: truncates payloadPreview to 512 chars
  // -------------------------------------------------------------------------
  it('truncates payloadPreview to 512 chars', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);

    seedRun(db, { id: 'run-trunc' });
    const longInput = 'a'.repeat(600);
    seedApproval(db, { id: 'approval-trunc', runId: 'run-trunc', toolName: 'Bash', toolInputJson: longInput, createdAt: '2026-01-01T00:00:00Z' });

    const result = selectPendingApprovals(adapter);

    expect(result).toHaveLength(1);
    expect(result[0].payloadPreview).toHaveLength(512);
    expect(result[0].payloadPreview).toBe(longInput.slice(0, 512));
  });

  // -------------------------------------------------------------------------
  // Case 4: resolves workflowName via JOIN to workflows.name
  // -------------------------------------------------------------------------
  it('resolves workflowName from workflows table via JOIN', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);

    const workflowName = 'my-important-workflow';
    seedRun(db, { id: 'run-join', workflowName });
    seedApproval(db, { id: 'approval-join', runId: 'run-join', toolName: 'Bash', toolInputJson: '{}', createdAt: '2026-01-01T00:00:00Z' });

    const result = selectPendingApprovals(adapter);

    expect(result).toHaveLength(1);
    expect(result[0].workflowName).toBe(workflowName);
  });

  // -------------------------------------------------------------------------
  // Case 5: excludes non-pending statuses
  // -------------------------------------------------------------------------
  it('excludes approved, rejected, timed_out statuses and returns only pending', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);

    seedRun(db, { id: 'run-filter' });

    // Insert one row of each non-pending status.
    seedApproval(db, { id: 'approval-approved', runId: 'run-filter', toolName: 'Bash', toolInputJson: '{}', status: 'approved', createdAt: '2026-01-01T00:00:01Z' });
    seedApproval(db, { id: 'approval-rejected', runId: 'run-filter', toolName: 'Bash', toolInputJson: '{}', status: 'rejected', createdAt: '2026-01-01T00:00:02Z' });
    seedApproval(db, { id: 'approval-timed_out', runId: 'run-filter', toolName: 'Bash', toolInputJson: '{}', status: 'timed_out', createdAt: '2026-01-01T00:00:03Z' });

    // And one pending row that SHOULD appear.
    seedApproval(db, { id: 'approval-pending', runId: 'run-filter', toolName: 'Bash', toolInputJson: '{}', status: 'pending', createdAt: '2026-01-01T00:00:04Z' });

    const result = selectPendingApprovals(adapter);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('approval-pending');
    expect(result[0].status).toBe('pending');
  });
});

describe('selectPendingApprovals — attribution', () => {
  it('degrades to nulls when the sessions join is unavailable', () => {
    // The orchestrator fixture builds no `sessions` table. An unconditional
    // LEFT JOIN would make this a SQL error rather than a null.
    const db = createTestDb();
    const adapter = dbAdapter(db);
    seedRun(db, { id: 'run-attr' });
    seedApproval(db, {
      id: 'approval-attr',
      runId: 'run-attr',
      toolName: 'Bash',
      toolInputJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

    const [approval] = selectPendingApprovals(adapter);
    expect(approval.sessionName).toBeNull();
    expect(approval.agentProvider).toBeNull();
  });
});

describe('toApprovalAttribution', () => {
  it('reads a runtime into its provider', () => {
    expect(toApprovalAttribution('sess', 'omp-sdk')).toEqual({
      sessionName: 'sess',
      agentProvider: 'omp',
    });
    expect(toApprovalAttribution(null, 'claude-interactive').agentProvider).toBe('claude');
    expect(toApprovalAttribution(null, 'codex-pty').agentProvider).toBe('codex');
  });

  it('leaves an absent runtime null rather than flooring it to claude', () => {
    // providerForRuntimeValue floors null to the Claude default, which would be
    // a guess. A card must not claim a provider the row never recorded.
    expect(toApprovalAttribution(null, null).agentProvider).toBeNull();
    expect(toApprovalAttribution(null, '').agentProvider).toBeNull();
  });

  it('treats an empty session name as absent', () => {
    expect(toApprovalAttribution('', 'omp-sdk').sessionName).toBeNull();
    expect(toApprovalAttribution(42, 'omp-sdk').sessionName).toBeNull();
  });
});
