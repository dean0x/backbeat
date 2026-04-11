/**
 * ActivityPanel — time-sorted activity feed across all entity kinds
 * ARCHITECTURE: Pure component — all state from props
 * Pattern: Uses ScrollableList primitive for consistent scroll behavior
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { ActivityEntry } from '../../../core/domain.js';
import { ScrollableList } from './scrollable-list.js';

const VIEWPORT_HEIGHT = 10;

interface ActivityPanelProps {
  readonly activityFeed: readonly ActivityEntry[];
  readonly selectedIndex: number;
  readonly scrollOffset: number;
  readonly focused: boolean;
  /** Called when the user presses Enter on a selected entry */
  readonly onSelect: (entry: ActivityEntry) => void;
}

function shortId(id: string): string {
  // Return first 12 chars (enough to identify without being too long)
  return id.slice(0, 12);
}

function formatTime(date: Date): string {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function kindLabel(kind: ActivityEntry['kind']): string {
  switch (kind) {
    case 'task':
      return 'task ';
    case 'loop':
      return 'loop ';
    case 'orchestration':
      return 'orch ';
    case 'schedule':
      return 'sched';
  }
}

function renderActivityRow(entry: ActivityEntry, _index: number, isSelected: boolean): React.ReactNode {
  const timeStr = formatTime(entry.timestamp);
  const kind = kindLabel(entry.kind);
  const id = shortId(entry.entityId);
  const status = entry.status.slice(0, 12).padEnd(12);
  const action = entry.action;

  return (
    <Box key={entry.entityId}>
      <Text bold={isSelected} inverse={isSelected}>
        {timeStr}
        {'  '}
        {kind}
        {'  '}
        {id}
        {'  '}
        {status}
        {'  '}
        {action}
      </Text>
    </Box>
  );
}

export const ActivityPanel: React.FC<ActivityPanelProps> = React.memo(
  ({ activityFeed, selectedIndex, scrollOffset, focused, onSelect: _onSelect }) => {
    const borderColor = focused ? 'cyan' : undefined;

    if (activityFeed.length === 0) {
      return (
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={borderColor} paddingX={1}>
          <Text bold={focused} color={focused ? 'cyan' : undefined}>
            Activity
          </Text>
          <Text dimColor>No recent activity</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={borderColor} paddingX={1}>
        <Text bold={focused} color={focused ? 'cyan' : undefined}>
          Activity
        </Text>
        <ScrollableList
          items={activityFeed as ActivityEntry[]}
          selectedIndex={selectedIndex}
          scrollOffset={scrollOffset}
          viewportHeight={VIEWPORT_HEIGHT}
          renderItem={renderActivityRow}
          keyExtractor={(item) => item.entityId}
        />
      </Box>
    );
  },
);

ActivityPanel.displayName = 'ActivityPanel';
