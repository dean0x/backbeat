import { ScheduleId } from '../../core/domain.js';
import { withServices } from '../services.js';
import * as ui from '../ui.js';

export async function handlePipelineCommand(pipelineArgs: string[]) {
  if (pipelineArgs.length === 0) {
    ui.error('Usage: beat pipeline <prompt> [<prompt>]...');
    process.stderr.write('Example: beat pipeline "setup db" "run migrations" "seed data"\n');
    process.exit(1);
  }

  // Each positional arg is a pipeline step prompt
  const steps = pipelineArgs.filter((arg) => !arg.startsWith('-'));

  if (steps.length === 0) {
    ui.error('No pipeline steps found');
    process.exit(1);
  }

  const s = ui.createSpinner();
  s.start(`Creating pipeline with ${steps.length} step${steps.length === 1 ? '' : 's'}...`);

  const { scheduleService } = await withServices(s);
  const { ScheduleType } = await import('../../core/domain.js');
  // Add 2-second buffer so "now" doesn't become "past" during validation
  const scheduledAt = new Date(Date.now() + 2000).toISOString();
  const createdSchedules: Array<{ id: string; prompt: string }> = [];
  let previousScheduleId: string | undefined;

  for (let i = 0; i < steps.length; i++) {
    const prompt = steps[i];
    s.message(`Creating step ${i + 1}/${steps.length}...`);

    const result = await scheduleService.createSchedule({
      prompt,
      scheduleType: ScheduleType.ONE_TIME,
      scheduledAt,
      afterScheduleId: previousScheduleId ? ScheduleId(previousScheduleId) : undefined,
    });

    if (!result.ok) {
      s.stop('Pipeline creation failed');
      ui.error(`Failed to create step ${i + 1}: ${result.error.message}`);
      process.exit(1);
    }

    previousScheduleId = result.value.id;
    createdSchedules.push({
      id: result.value.id,
      prompt: prompt.substring(0, 50) + (prompt.length > 50 ? '...' : ''),
    });
  }

  s.stop('Pipeline created');

  // Show pipeline visualization
  const lines: string[] = [];
  for (let i = 0; i < createdSchedules.length; i++) {
    const cs = createdSchedules[i];
    lines.push(`${i + 1}. ${ui.dim(`[${cs.id}]`)} "${cs.prompt}"`);
    if (i < createdSchedules.length - 1) {
      lines.push('   ↓');
    }
  }
  ui.note(lines.join('\n'), 'Pipeline Steps');

  process.exit(0);
}
