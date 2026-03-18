import { TaskId } from '../../core/domain.js';
import { taskNotFound } from '../../core/errors.js';
import type { ReadOnlyContext } from '../read-only-context.js';
import { errorMessage, withReadOnlyContext } from '../services.js';
import * as ui from '../ui.js';

export async function getTaskStatus(taskId?: string): Promise<void> {
  const s = ui.createSpinner();
  let ctx: ReadOnlyContext | undefined;
  try {
    s.start(taskId ? `Fetching status for ${taskId}...` : 'Fetching tasks...');
    ctx = withReadOnlyContext(s);

    if (taskId) {
      const result = await ctx.taskRepository.findById(TaskId(taskId));
      if (!result.ok) {
        s.stop('Failed');
        ui.error(`Failed to get task status: ${result.error.message}`);
        process.exit(1);
      }
      if (!result.value) {
        s.stop('Not found');
        ui.error(`Failed to get task status: ${taskNotFound(taskId).message}`);
        process.exit(1);
      }
      const task = result.value;
      s.stop('Task found');

      const lines: string[] = [];
      lines.push(`ID:       ${task.id}`);
      lines.push(`Status:   ${ui.colorStatus(task.status)}`);
      lines.push(`Priority: ${task.priority}`);
      lines.push(`Agent:    ${task.agent ?? 'unknown'}`);
      if (task.startedAt) lines.push(`Started:  ${new Date(task.startedAt).toISOString()}`);
      if (task.completedAt) lines.push(`Completed: ${new Date(task.completedAt).toISOString()}`);
      if (task.exitCode !== undefined) lines.push(`Exit Code: ${task.exitCode}`);
      if (task.completedAt && task.startedAt) {
        lines.push(`Duration: ${ui.formatDuration(task.completedAt - task.startedAt)}`);
      }
      lines.push(`Prompt:   ${task.prompt.substring(0, 100)}${task.prompt.length > 100 ? '...' : ''}`);

      // Dependencies
      if (task.dependsOn && task.dependsOn.length > 0) {
        lines.push('');
        lines.push(`Depends On: ${task.dependsOn.join(', ')}`);
        if (task.dependencyState) {
          lines.push(`Dep State:  ${task.dependencyState}`);
          if (task.dependencyState === 'blocked') {
            lines.push(`            Waiting for dependencies to complete`);
          } else if (task.dependencyState === 'ready') {
            lines.push(`            All dependencies satisfied`);
          }
        }
      }

      if (task.dependents && task.dependents.length > 0) {
        lines.push('');
        lines.push(`Dependents: ${task.dependents.join(', ')}`);
      }

      ui.note(lines.join('\n'), 'Task Details');
    } else {
      const result = await ctx.taskRepository.findAll();
      if (result.ok && Array.isArray(result.value) && result.value.length > 0) {
        s.stop(`${result.value.length} task${result.value.length === 1 ? '' : 's'}`);

        for (const task of result.value) {
          const prompt = task.prompt.substring(0, 50) + (task.prompt.length > 50 ? '...' : '');
          ui.step(`${ui.dim(task.id)}  ${ui.colorStatus(task.status.padEnd(10))}  ${prompt}`);
        }
      } else if (result.ok) {
        s.stop('Done');
        ui.info('No tasks found');
      } else {
        s.stop('Failed');
        ui.error(`Failed to get tasks: ${result.error.message}`);
        process.exit(1);
      }
    }
    process.exit(0);
  } catch (error) {
    s.stop('Failed');
    ui.error(errorMessage(error));
    process.exit(1);
  } finally {
    ctx?.close();
  }
}
