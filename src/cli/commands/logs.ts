import { TaskId } from '../../core/domain.js';
import { taskNotFound } from '../../core/errors.js';
import type { ReadOnlyContext } from '../read-only-context.js';
import { errorMessage, withReadOnlyContext } from '../services.js';
import * as ui from '../ui.js';

export async function getTaskLogs(taskId: string, tail?: number): Promise<void> {
  const s = ui.createSpinner();
  let ctx: ReadOnlyContext | undefined;
  try {
    s.start(`Fetching logs for ${taskId}...`);
    ctx = withReadOnlyContext(s);

    // Validate task exists
    const taskResult = await ctx.taskRepository.findById(TaskId(taskId));
    if (!taskResult.ok) {
      s.stop('Failed');
      ui.error(`Failed to get task logs: ${taskResult.error.message}`);
      process.exit(1);
    }
    if (!taskResult.value) {
      s.stop('Not found');
      ui.error(`Failed to get task logs: ${taskNotFound(taskId).message}`);
      process.exit(1);
    }

    // Read output directly from repository (skip in-memory OutputCapture — always empty for CLI)
    const outputResult = await ctx.outputRepository.get(TaskId(taskId));
    if (!outputResult.ok) {
      s.stop('Failed');
      ui.error(`Failed to get task logs: ${outputResult.error.message}`);
      process.exit(1);
    }

    if (!outputResult.value) {
      s.stop('No output captured');
      process.exit(0);
    }

    const output = outputResult.value;

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
      process.exit(0);
    }

    s.stop(`Logs for ${taskId}`);

    if (stdoutLines.length > 0) {
      ui.step(`stdout${tail ? ` (last ${tail} lines)` : ''}`);
      for (const line of stdoutLines) {
        process.stderr.write(`${line}\n`);
      }
    }
    if (stderrLines.length > 0) {
      ui.step(`stderr${tail ? ` (last ${tail} lines)` : ''}`);
      for (const line of stderrLines) {
        process.stderr.write(`${line}\n`);
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
