import { AGENT_PROVIDERS, type AgentProvider, isAgentProvider } from '../../core/agents.js';
import { Priority, ScheduleId, ScheduleStatus, ScheduleType } from '../../core/domain.js';
import type { ScheduleExecution, ScheduleRepository, ScheduleService } from '../../core/interfaces.js';
import { toMissedRunPolicy, truncatePrompt } from '../../utils/format.js';
import { validatePath } from '../../utils/validation.js';
import { exitOnError, exitOnNull, withReadOnlyContext, withServices } from '../services.js';
import * as ui from '../ui.js';

export async function handleScheduleCommand(subCmd: string | undefined, scheduleArgs: string[]): Promise<void> {
  if (!subCmd) {
    ui.error('Usage: beat schedule <create|list|get|cancel|pause|resume>');
    process.exit(1);
  }

  // Read-only subcommands: lightweight context, no full bootstrap
  if (subCmd === 'list' || subCmd === 'get') {
    const s = ui.createSpinner();
    s.start(subCmd === 'list' ? 'Fetching schedules...' : 'Fetching schedule...');
    const ctx = withReadOnlyContext(s);
    s.stop('Ready');

    try {
      if (subCmd === 'list') {
        await scheduleList(ctx.scheduleRepository, scheduleArgs);
      } else {
        await scheduleGet(ctx.scheduleRepository, scheduleArgs);
      }
    } finally {
      ctx.close();
    }
    process.exit(0);
  }

  // Mutation subcommands: full bootstrap
  const s = ui.createSpinner();
  s.start('Initializing...');
  const { scheduleService } = await withServices(s);
  s.stop('Ready');

  switch (subCmd) {
    case 'create':
      await scheduleCreate(scheduleService, scheduleArgs);
      break;
    case 'cancel':
      await scheduleCancel(scheduleService, scheduleArgs);
      break;
    case 'pause':
      await schedulePause(scheduleService, scheduleArgs);
      break;
    case 'resume':
      await scheduleResume(scheduleService, scheduleArgs);
      break;
    default:
      ui.error(`Unknown schedule subcommand: ${subCmd}`);
      process.stderr.write('Valid subcommands: create, list, get, cancel, pause, resume\n');
      process.exit(1);
  }
  process.exit(0);
}

async function scheduleCreate(service: ScheduleService, scheduleArgs: string[]): Promise<void> {
  const promptWords: string[] = [];
  let scheduleType: 'cron' | 'one_time' | undefined;
  let cronExpression: string | undefined;
  let scheduledAt: string | undefined;
  let timezone: string | undefined;
  let missedRunPolicy: 'skip' | 'catchup' | 'fail' | undefined;
  let priority: 'P0' | 'P1' | 'P2' | undefined;
  let workingDirectory: string | undefined;
  let maxRuns: number | undefined;
  let expiresAt: string | undefined;
  let afterScheduleId: string | undefined;
  let agent: AgentProvider | undefined;
  let isPipeline = false;
  const pipelineSteps: string[] = [];

  for (let i = 0; i < scheduleArgs.length; i++) {
    const arg = scheduleArgs[i];
    const next = scheduleArgs[i + 1];

    if (arg === '--type' && next) {
      if (next !== 'cron' && next !== 'one_time') {
        ui.error('--type must be "cron" or "one_time"');
        process.exit(1);
      }
      scheduleType = next;
      i++;
    } else if (arg === '--cron' && next) {
      cronExpression = next;
      i++;
    } else if (arg === '--at' && next) {
      scheduledAt = next;
      i++;
    } else if (arg === '--timezone' && next) {
      timezone = next;
      i++;
    } else if (arg === '--missed-run-policy' && next) {
      if (!['skip', 'catchup', 'fail'].includes(next)) {
        ui.error('--missed-run-policy must be "skip", "catchup", or "fail"');
        process.exit(1);
      }
      missedRunPolicy = next as 'skip' | 'catchup' | 'fail';
      i++;
    } else if ((arg === '--priority' || arg === '-p') && next) {
      if (!['P0', 'P1', 'P2'].includes(next)) {
        ui.error('Priority must be P0, P1, or P2');
        process.exit(1);
      }
      priority = next as 'P0' | 'P1' | 'P2';
      i++;
    } else if ((arg === '--working-directory' || arg === '-w') && next) {
      const pathResult = validatePath(next);
      if (!pathResult.ok) {
        ui.error(`Invalid working directory: ${pathResult.error.message}`);
        process.exit(1);
      }
      workingDirectory = pathResult.value;
      i++;
    } else if (arg === '--max-runs' && next) {
      maxRuns = parseInt(next);
      if (isNaN(maxRuns) || maxRuns < 1) {
        ui.error('--max-runs must be a positive integer');
        process.exit(1);
      }
      i++;
    } else if (arg === '--expires-at' && next) {
      expiresAt = next;
      i++;
    } else if (arg === '--after' && next) {
      afterScheduleId = next;
      i++;
    } else if (arg === '--agent' || arg === '-a') {
      if (!next || next.startsWith('-')) {
        ui.error(`--agent requires an agent name (${AGENT_PROVIDERS.join(', ')})`);
        process.exit(1);
      }
      if (!isAgentProvider(next)) {
        ui.error(`Unknown agent: "${next}". Available agents: ${AGENT_PROVIDERS.join(', ')}`);
        process.exit(1);
      }
      agent = next;
      i++;
    } else if (arg === '--pipeline') {
      isPipeline = true;
    } else if (arg === '--step' && next) {
      pipelineSteps.push(next);
      i++;
    } else if (arg.startsWith('-')) {
      ui.error(`Unknown flag: ${arg}`);
      process.exit(1);
    } else {
      promptWords.push(arg);
    }
  }

  // Infer type from --cron / --at flags
  if (cronExpression && scheduledAt) {
    ui.error('Cannot specify both --cron and --at');
    process.exit(1);
  }
  const inferredType = cronExpression ? 'cron' : scheduledAt ? 'one_time' : undefined;
  if (scheduleType && inferredType && scheduleType !== inferredType) {
    ui.error(`--type ${scheduleType} conflicts with ${cronExpression ? '--cron' : '--at'}`);
    process.exit(1);
  }
  scheduleType = scheduleType ?? inferredType;
  if (!scheduleType) {
    ui.error('Provide --cron, --at, or --type');
    process.exit(1);
  }

  // Pipeline mode: --pipeline with --step flags
  if (isPipeline) {
    if (promptWords.length > 0) {
      ui.info(`Ignoring positional prompt text in --pipeline mode: "${promptWords.join(' ')}". Use --step flags only.`);
    }
    if (pipelineSteps.length < 2) {
      ui.error('Pipeline requires at least 2 --step flags');
      process.exit(1);
    }

    const result = await service.createScheduledPipeline({
      steps: pipelineSteps.map((prompt) => ({ prompt })),
      scheduleType: scheduleType === 'cron' ? ScheduleType.CRON : ScheduleType.ONE_TIME,
      cronExpression,
      scheduledAt,
      timezone,
      missedRunPolicy: missedRunPolicy ? toMissedRunPolicy(missedRunPolicy) : undefined,
      priority: priority ? Priority[priority] : undefined,
      workingDirectory,
      maxRuns,
      expiresAt,
      afterScheduleId: afterScheduleId ? ScheduleId(afterScheduleId) : undefined,
      agent,
    });

    const pipeline = exitOnError(result, undefined, 'Failed to create scheduled pipeline');
    ui.success(`Scheduled pipeline created: ${pipeline.id}`);
    const details = [
      `Type: ${pipeline.scheduleType}`,
      `Steps: ${pipeline.pipelineSteps?.length ?? 0}`,
      `Status: ${pipeline.status}`,
    ];
    if (pipeline.nextRunAt) details.push(`Next run: ${new Date(pipeline.nextRunAt).toISOString()}`);
    if (pipeline.cronExpression) details.push(`Cron: ${pipeline.cronExpression}`);
    if (agent) details.push(`Agent: ${agent}`);
    ui.info(details.join(' | '));
    process.exit(0);
  }

  // Guard: --step without --pipeline is a user error
  if (pipelineSteps.length > 0) {
    ui.error('--step requires --pipeline. Did you mean: beat schedule create --pipeline --step "..." --step "..."');
    process.exit(1);
  }

  // Single-task mode
  const prompt = promptWords.join(' ');
  if (!prompt) {
    ui.error('Usage: beat schedule create <prompt> --cron "..." | --at "..." [options]');
    ui.info('  Pipeline: beat schedule create --pipeline --step "lint" --step "test" --cron "0 9 * * *"');
    process.exit(1);
  }

  const result = await service.createSchedule({
    prompt,
    scheduleType: scheduleType === 'cron' ? ScheduleType.CRON : ScheduleType.ONE_TIME,
    cronExpression,
    scheduledAt,
    timezone,
    missedRunPolicy: missedRunPolicy ? toMissedRunPolicy(missedRunPolicy) : undefined,
    priority: priority ? Priority[priority] : undefined,
    workingDirectory,
    maxRuns,
    expiresAt,
    afterScheduleId: afterScheduleId ? ScheduleId(afterScheduleId) : undefined,
    agent,
  });

  const created = exitOnError(result, undefined, 'Failed to create schedule');
  ui.success(`Schedule created: ${created.id}`);
  const details = [`Type: ${created.scheduleType}`, `Status: ${created.status}`];
  if (created.nextRunAt) details.push(`Next run: ${new Date(created.nextRunAt).toISOString()}`);
  if (created.cronExpression) details.push(`Cron: ${created.cronExpression}`);
  if (created.afterScheduleId) details.push(`After: ${created.afterScheduleId}`);
  if (agent) details.push(`Agent: ${agent}`);
  ui.info(details.join(' | '));
  process.exit(0);
}

async function scheduleList(repo: ScheduleRepository, scheduleArgs: string[]): Promise<void> {
  let status: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < scheduleArgs.length; i++) {
    const arg = scheduleArgs[i];
    const next = scheduleArgs[i + 1];

    if (arg === '--status' && next) {
      status = next;
      i++;
    } else if (arg === '--limit' && next) {
      limit = parseInt(next);
      i++;
    }
  }

  const validStatuses = Object.values(ScheduleStatus);

  let statusValue: ScheduleStatus | undefined;
  if (status) {
    const normalized = status.toLowerCase();
    statusValue = validStatuses.find((v) => v === normalized);
    if (!statusValue) {
      ui.error(`Invalid status: ${status}. Valid values: ${validStatuses.join(', ')}`);
      process.exit(1);
    }
  }

  const result = statusValue ? await repo.findByStatus(statusValue, limit) : await repo.findAll(limit);
  const schedules = exitOnError(result, undefined, 'Failed to list schedules');

  if (schedules.length === 0) {
    ui.info('No schedules found');
  } else {
    for (const s of schedules) {
      const nextRun = s.nextRunAt ? new Date(s.nextRunAt).toISOString() : 'none';
      ui.step(
        `${ui.dim(s.id)}  ${ui.colorStatus(s.status.padEnd(10))}  ${s.scheduleType}  runs: ${s.runCount}${s.maxRuns ? '/' + s.maxRuns : ''}  next: ${nextRun}`,
      );
    }
    ui.info(`${schedules.length} schedule${schedules.length === 1 ? '' : 's'}`);
  }
}

async function scheduleGet(repo: ScheduleRepository, scheduleArgs: string[]): Promise<void> {
  const scheduleId = scheduleArgs[0];
  if (!scheduleId) {
    ui.error('Usage: beat schedule get <schedule-id> [--history] [--history-limit N]');
    process.exit(1);
  }

  const includeHistory = scheduleArgs.includes('--history');
  let historyLimit: number | undefined;
  const hlIdx = scheduleArgs.indexOf('--history-limit');
  if (hlIdx !== -1 && scheduleArgs[hlIdx + 1]) {
    historyLimit = parseInt(scheduleArgs[hlIdx + 1]);
  }

  const scheduleResult = await repo.findById(ScheduleId(scheduleId));
  const found = exitOnError(scheduleResult, undefined, 'Failed to get schedule');
  const schedule = exitOnNull(found, undefined, `Schedule ${scheduleId} not found`);

  let history: readonly ScheduleExecution[] | undefined;
  if (includeHistory) {
    const historyResult = await repo.getExecutionHistory(ScheduleId(scheduleId), historyLimit);
    history = exitOnError(historyResult, undefined, 'Failed to fetch execution history');
  }

  const lines: string[] = [];
  lines.push(`ID:          ${schedule.id}`);
  lines.push(`Status:      ${ui.colorStatus(schedule.status)}`);
  lines.push(`Type:        ${schedule.scheduleType}`);
  if (schedule.cronExpression) lines.push(`Cron:        ${schedule.cronExpression}`);
  if (schedule.scheduledAt) lines.push(`Scheduled:   ${new Date(schedule.scheduledAt).toISOString()}`);
  lines.push(`Timezone:    ${schedule.timezone}`);
  lines.push(`Missed Policy: ${schedule.missedRunPolicy}`);
  lines.push(`Run Count:   ${schedule.runCount}${schedule.maxRuns ? '/' + schedule.maxRuns : ''}`);
  if (schedule.lastRunAt) lines.push(`Last Run:    ${new Date(schedule.lastRunAt).toISOString()}`);
  if (schedule.nextRunAt) lines.push(`Next Run:    ${new Date(schedule.nextRunAt).toISOString()}`);
  if (schedule.expiresAt) lines.push(`Expires:     ${new Date(schedule.expiresAt).toISOString()}`);
  if (schedule.afterScheduleId) lines.push(`After:       ${schedule.afterScheduleId}`);
  lines.push(`Created:     ${new Date(schedule.createdAt).toISOString()}`);
  lines.push(`Prompt:      ${truncatePrompt(schedule.taskTemplate.prompt, 100)}`);
  if (schedule.taskTemplate.agent) lines.push(`Agent:       ${schedule.taskTemplate.agent}`);

  if (schedule.pipelineSteps && schedule.pipelineSteps.length > 0) {
    lines.push(`Pipeline:    ${schedule.pipelineSteps.length} steps`);
    for (let i = 0; i < schedule.pipelineSteps.length; i++) {
      const step = schedule.pipelineSteps[i];
      const stepInfo = `  Step ${i + 1}: ${truncatePrompt(step.prompt, 60)}`;
      lines.push(stepInfo);
    }
  }

  ui.note(lines.join('\n'), 'Schedule Details');

  if (history && history.length > 0) {
    ui.step(`Execution History (${history.length} entries)`);
    for (const h of history) {
      const scheduled = new Date(h.scheduledFor).toISOString();
      const executed = h.executedAt ? new Date(h.executedAt).toISOString() : 'n/a';
      process.stderr.write(
        `  ${h.status} | scheduled: ${scheduled} | executed: ${executed}${h.taskId ? ' | task: ' + h.taskId : ''}${h.errorMessage ? ' | error: ' + h.errorMessage : ''}\n`,
      );
    }
  }
}

async function scheduleCancel(service: ScheduleService, scheduleArgs: string[]): Promise<void> {
  let cancelTasks = false;
  const filteredArgs: string[] = [];

  for (const arg of scheduleArgs) {
    if (arg === '--cancel-tasks') {
      cancelTasks = true;
    } else {
      filteredArgs.push(arg);
    }
  }

  const scheduleId = filteredArgs[0];
  if (!scheduleId) {
    ui.error('Usage: beat schedule cancel <schedule-id> [--cancel-tasks] [reason]');
    process.exit(1);
  }
  const reason = filteredArgs.slice(1).join(' ') || undefined;

  const result = await service.cancelSchedule(ScheduleId(scheduleId), reason, cancelTasks);
  exitOnError(result, undefined, 'Failed to cancel schedule');
  ui.success(`Schedule ${scheduleId} cancelled`);
  if (cancelTasks) ui.info('In-flight tasks also cancelled');
  if (reason) ui.info(`Reason: ${reason}`);
}

async function schedulePause(service: ScheduleService, scheduleArgs: string[]): Promise<void> {
  const scheduleId = scheduleArgs[0];
  if (!scheduleId) {
    ui.error('Usage: beat schedule pause <schedule-id>');
    process.exit(1);
  }

  const result = await service.pauseSchedule(ScheduleId(scheduleId));
  exitOnError(result, undefined, 'Failed to pause schedule');
  ui.success(`Schedule ${scheduleId} paused`);
}

async function scheduleResume(service: ScheduleService, scheduleArgs: string[]): Promise<void> {
  const scheduleId = scheduleArgs[0];
  if (!scheduleId) {
    ui.error('Usage: beat schedule resume <schedule-id>');
    process.exit(1);
  }

  const result = await service.resumeSchedule(ScheduleId(scheduleId));
  exitOnError(result, undefined, 'Failed to resume schedule');
  ui.success(`Schedule ${scheduleId} resumed`);
}
