/**
 * CountsPanel — compact vertical layout showing aggregate entity counts
 * ARCHITECTURE: Pure component — all state from props
 * Pattern: Functional core — renders nested status counts
 */

import { Box, Text } from 'ink';
import React from 'react';

interface StatusGroup {
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
}

interface CountsPanelProps {
  readonly counts: {
    readonly orchestrations: StatusGroup;
    readonly loops: StatusGroup;
    readonly tasks: StatusGroup;
    readonly schedules: StatusGroup;
  };
}

interface SectionProps {
  readonly label: string;
  readonly group: StatusGroup;
}

const Section: React.FC<SectionProps> = ({ label, group }) => (
  <Box flexDirection="column">
    <Text bold>{label}</Text>
    <Box flexDirection="row" gap={1}>
      <Text color="green"> run {group.running}</Text>
      <Text dimColor>done {group.completed}</Text>
      {group.failed > 0 && <Text color="red">fail {group.failed}</Text>}
    </Box>
  </Box>
);

export const CountsPanel: React.FC<CountsPanelProps> = React.memo(({ counts }) => {
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={1}>
      <Text bold>Counts</Text>
      <Section label="Orchestrations" group={counts.orchestrations} />
      <Section label="Loops" group={counts.loops} />
      <Section label="Tasks" group={counts.tasks} />
      <Section label="Schedules" group={counts.schedules} />
    </Box>
  );
});

CountsPanel.displayName = 'CountsPanel';
