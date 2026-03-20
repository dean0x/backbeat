import { TaskId } from '../../core/domain.js';
import { taskNotFound } from '../../core/errors.js';
import type { ReadOnlyContext } from '../read-only-context.js';
import { errorMessage, exitOnError, exitOnNull, withReadOnlyContext } from '../services.js';
import * as ui from '../ui.js';

export async function getTaskLogs(taskId: string, tail?: number): Promise<void> {
  const s = ui.createSpinner();
  let ctx: ReadOnlyContext | undefined;
  try {
    s.start(`Fetching logs for ${taskId}...`);
    ctx = withReadOnlyContext(s);

    // Validate task exists
    const taskResult = await ctx.taskRepository.findById(TaskId(taskId));
    exitOnNull(
      exitOnError(taskResult, s, 'Failed to get task logs'),
      s,
      `Failed to get task logs: ${taskNotFound(taskId).message}`,
    );

    // Read output directly from repository (skip in-memory OutputCapture — always empty for CLI)
    const outputResult = await ctx.outputRepository.get(TaskId(taskId));
    const output = exitOnError(outputResult, s, 'Failed to get task logs');

    if (!output) {
      s.stop('No output captured');
      return;
    }

    // Apply tail slicing if requested
    let stdoutLines = output.stdout || [];
    let stderrLines = output.stderr || [];

    if (tail && tail > 0) {
      stdoutLines = stdoutLines.slice(-tail);
      stderrLines = stderrLines.slice(-tail);
    }

    const hasOutput = stdoutLines.length > 0 || stderrLines.length > 0;

    if (!hasOutput) {
      s.stop('No output captured');
      return;
    }

    s.stop(`Logs for ${taskId}`);

    if (stdoutLines.length > 0) {
      ui.step(`stdout${tail ? ` (last ${tail} lines)` : ''}`);
      for (const line of stdoutLines) {
        process.stdout.write(`${line}\n`);
      }
    }
    if (stderrLines.length > 0) {
      ui.step(`stderr${tail ? ` (last ${tail} lines)` : ''}`);
      for (const line of stderrLines) {
        process.stderr.write(`${line}\n`);
      }
    }
  } catch (error) {
    s.stop('Failed');
    ui.error(errorMessage(error));
    process.exit(1);
  } finally {
    ctx?.close();
  }
  process.exit(0);
}
