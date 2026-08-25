import { IpcMain } from 'electron';
import { z } from 'zod';
import type { AppServices } from './types';
import { validateInput } from './validateInput';
import {
  ALL_AGENT_RUNTIMES,
  isAgentProviderAccess,
  resolveAgentProviderAccess,
} from '../../../shared/types/agentRuntime';
import { ALL_EFFORT_LEVELS } from '../../../shared/types/reasoningEffort';
import {
  clampSprintMaxTasks,
  type SprintMaxTasksOverrides,
} from '../../../shared/types/sprintBatch';
import { PERMISSION_MODES } from '../../../shared/types/workflows';

const runTypeDefaultsFields = {
  model: z.string().optional().nullable(),
  permissionMode: z.enum(PERMISSION_MODES).optional().nullable(),
  substrate: z.enum(['sdk', 'interactive']).optional().nullable(),
  // The persisted run-type default is not scoped to one launch kind, so it
  // validates against the FULL runtime union; each launch surface re-narrows to
  // its own set.
  agentRuntime: z.enum(ALL_AGENT_RUNTIMES).optional().nullable(),
  reasoningEffort: z.enum(ALL_EFFORT_LEVELS).optional().nullable(),
};

const runTypeDefaultsOpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('merge'),
    value: z.object(runTypeDefaultsFields).strict(),
  }),
  z.object({
    kind: z.literal('replace'),
    value: z.object({
      ...runTypeDefaultsFields,
      model: z.string().optional(),
      permissionMode: z.enum(PERMISSION_MODES).optional(),
      substrate: z.enum(['sdk', 'interactive']).optional(),
      agentRuntime: z.enum(ALL_AGENT_RUNTIMES).optional(),
      reasoningEffort: z.enum(ALL_EFFORT_LEVELS).optional(),
    }).strict().nullable(),
  }),
]);

export function registerConfigHandlers(ipcMain: IpcMain, { configManager, claudeCodeManager }: AppServices): void {
  ipcMain.handle('config:get', async () => {
    try {
      const config = configManager.getConfig();
      return { success: true, data: config };
    } catch (error) {
      console.error('Failed to get config:', error);
      return { success: false, error: 'Failed to get config' };
    }
  });

  ipcMain.handle('config:update', async (_event, updates: import('../types/config').UpdateConfigRequest) => {
    try {
      // Check if Claude path is being updated
      const oldConfig = configManager.getConfig();
      const claudePathChanged = updates.claudeExecutablePath !== undefined &&
                               updates.claudeExecutablePath !== oldConfig.claudeExecutablePath;

      // Validate the untyped provider-access patch at the IPC boundary: a
      // malformed shape is rejected outright, and a well-formed one is stored
      // normalized (both members explicit, never all-off) so every downstream
      // read — including a config.json edited by hand — sees the floors already
      // applied. See shared/types/agentRuntime.ts.
      if (updates.agentProviderAccess !== undefined && !isAgentProviderAccess(updates.agentProviderAccess)) {
        return { success: false, error: 'Invalid agentProviderAccess payload' };
      }
      let normalized = updates.agentProviderAccess === undefined
        ? updates
        : { ...updates, agentProviderAccess: resolveAgentProviderAccess(updates.agentProviderAccess) };

      // Same treatment for the sprint cap override: reject a malformed shape at
      // the boundary, and STORE the clamped map so config.json never holds a 0 or
      // a 10_000 that every reader would have to re-clamp. A member the caller
      // clears (undefined / null) drops out entirely, which is how the UI resets a
      // substrate back to its built-in default.
      if (updates.sprintMaxTasks !== undefined) {
        const patch: unknown = updates.sprintMaxTasks;
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          return { success: false, error: 'Invalid sprintMaxTasks payload' };
        }
        const raw = patch as Record<string, unknown>;
        const clean: SprintMaxTasksOverrides = {};
        for (const substrate of ['sdk', 'interactive'] as const) {
          const value = raw[substrate];
          if (value === undefined || value === null) continue;
          const clamped = clampSprintMaxTasks(value);
          if (clamped === null) {
            return { success: false, error: `Invalid sprintMaxTasks.${substrate}: expected a number` };
          }
          clean[substrate] = clamped;
        }
        normalized = { ...normalized, sprintMaxTasks: clean };
      }

      await configManager.updateConfig(normalized);
      
      // Clear Claude availability cache if the path changed
      if (claudePathChanged) {
        claudeCodeManager.clearAvailabilityCache();
        console.log('[Config] Claude executable path changed, cleared availability cache');
      }
      
      return { success: true };
    } catch (error) {
      console.error('Failed to update config:', error);
      return { success: false, error: 'Failed to update config' };
    }
  });

  ipcMain.handle(
    'config:apply-run-type-default',
    async (
      _event,
      key: string,
      op: unknown,
    ) => {
      try {
        const input = validateInput(
          z.object({ key: z.string().min(1), op: runTypeDefaultsOpSchema }),
          { key, op },
          'config:apply-run-type-default',
        );
        if (!input.ok) return { success: false, error: input.error };

        const result = await configManager.applyRunTypeDefault(input.value.key, input.value.op);
        return { success: true, data: result };
      } catch (error) {
        console.error('Failed to apply run type default:', error);
        return { success: false, error: 'Failed to apply run type default' };
      }
    },
  );

  ipcMain.handle('config:get-session-preferences', async () => {
    try {
      const preferences = configManager.getSessionCreationPreferences();
      return { success: true, data: preferences };
    } catch (error) {
      console.error('Failed to get session creation preferences:', error);
      return { success: false, error: 'Failed to get session creation preferences' };
    }
  });

  ipcMain.handle('config:update-session-preferences', async (_event, preferences: NonNullable<import('../types/config').AppConfig['sessionCreationPreferences']>) => {
    try {
      await configManager.updateConfig({ sessionCreationPreferences: preferences });
      return { success: true };
    } catch (error) {
      console.error('Failed to update session creation preferences:', error);
      return { success: false, error: 'Failed to update session creation preferences' };
    }
  });
}
