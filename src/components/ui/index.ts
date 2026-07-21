/**
 * Barrel export for the shared dashboard widget kit. Screen-builder agents
 * should import from '@/components/ui' rather than reaching into individual
 * files directly.
 */

export { default as Panel } from './Panel';
export type { PanelProps } from './Panel';

export { default as StatChip } from './StatChip';
export type { StatChipProps, StatChipTrend } from './StatChip';

export { default as Donut } from './Donut';
export type { DonutProps } from './Donut';

export { default as BarChart } from './BarChart';
export type { BarChartProps, BarChartDatum } from './BarChart';

export { default as Sparkline } from './Sparkline';
export type { SparklineProps } from './Sparkline';

export { default as ProgressBar } from './ProgressBar';
export type { ProgressBarProps } from './ProgressBar';

export { default as AgentRow } from './AgentRow';
export type { AgentRowProps, AgentRowVariant } from './AgentRow';

export { default as ActivityItem } from './ActivityItem';
export type { ActivityItemProps } from './ActivityItem';
