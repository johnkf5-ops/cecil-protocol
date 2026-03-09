import {
  getCurrentMemories,
  getMemoryEvents,
  getRankedRecallCandidates,
  type StructuredMemoryEventRecord,
  type StructuredMemoryRecord,
} from "./memory-store";
import type { MemorySourceType, MemoryType } from "./types";

const ALL_MEMORY_TYPES: MemoryType[] = [
  "seed",
  "conversation",
  "observation",
  "fact",
  "podcast",
  "milestone",
];

const STALE_MEMORY_DAYS = 30;
const LOW_QUALITY_THRESHOLD = 0.45;
const DUPLICATE_NORMALIZED_MIN_LENGTH = 24;

export interface MemoryAuditTypeSummary {
  memoryType: MemoryType;
  currentCount: number;
  eventCount: number;
  averageQualityScore: number;
  newestCurrentAt?: string;
  newestEventAt?: string;
}

export interface MemoryAuditSourceSummary {
  sourceType: MemorySourceType;
  currentCount: number;
  eventCount: number;
}

export interface MemoryAuditIssue {
  severity: "info" | "warning";
  code:
    | "missing_type"
    | "stale_type"
    | "low_quality_memory"
    | "duplicate_memory"
    | "no_events"
    | "no_current";
  message: string;
}

export interface MemoryAuditDuplicateGroup {
  text: string;
  memoryType: MemoryType;
  currentCount: number;
  memoryKeys: string[];
}

export interface MemoryAuditStaleGroup {
  memoryType: MemoryType;
  newestCurrentAt?: string;
  ageDays?: number;
}

export interface MemoryAuditResult {
  totals: {
    current: number;
    events: number;
    typesPresent: number;
    sourceTypesPresent: number;
  };
  byType: MemoryAuditTypeSummary[];
  bySource: MemoryAuditSourceSummary[];
  issues: MemoryAuditIssue[];
  stale: MemoryAuditStaleGroup[];
  lowQuality: StructuredMemoryRecord[];
  duplicateGroups: MemoryAuditDuplicateGroup[];
  rankedPreview: Awaited<ReturnType<typeof getRankedRecallCandidates>>;
}

interface BuildMemoryAuditOptions {
  query?: string;
  limit?: number;
}

function normalizeDuplicateText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

function daysOld(timestamp?: string): number | undefined {
  if (!timestamp) {
    return undefined;
  }

  const ageMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return undefined;
  }

  return ageMs / (1000 * 60 * 60 * 24);
}

function averageQuality(rows: StructuredMemoryRecord[]): number {
  if (rows.length === 0) {
    return 0;
  }

  const total = rows.reduce((sum, row) => sum + row.qualityScore, 0);
  return total / rows.length;
}

function groupByType<T extends { memoryType: MemoryType }>(
  rows: T[]
): Map<MemoryType, T[]> {
  const map = new Map<MemoryType, T[]>();

  for (const row of rows) {
    const group = map.get(row.memoryType) ?? [];
    group.push(row);
    map.set(row.memoryType, group);
  }

  return map;
}

function groupEventsByType(
  rows: StructuredMemoryEventRecord[]
): Map<MemoryType, StructuredMemoryEventRecord[]> {
  return groupByType(rows);
}

function buildTypeSummary(
  current: StructuredMemoryRecord[],
  events: StructuredMemoryEventRecord[]
): MemoryAuditTypeSummary[] {
  const currentByType = groupByType(current);
  const eventsByType = groupEventsByType(events);

  return ALL_MEMORY_TYPES.map((memoryType) => {
    const currentRows = currentByType.get(memoryType) ?? [];
    const eventRows = eventsByType.get(memoryType) ?? [];

    return {
      memoryType,
      currentCount: currentRows.length,
      eventCount: eventRows.length,
      averageQualityScore: averageQuality(currentRows),
      newestCurrentAt: currentRows[0]?.updatedAt,
      newestEventAt: eventRows[0]?.createdAt,
    };
  });
}

function buildSourceSummary(
  current: StructuredMemoryRecord[],
  events: StructuredMemoryEventRecord[]
): MemoryAuditSourceSummary[] {
  const sourceTypes = new Set<MemorySourceType>();

  for (const row of current) {
    sourceTypes.add(row.sourceType);
  }

  for (const row of events) {
    sourceTypes.add(row.sourceType);
  }

  return Array.from(sourceTypes)
    .sort()
    .map((sourceType) => ({
      sourceType,
      currentCount: current.filter((row) => row.sourceType === sourceType).length,
      eventCount: events.filter((row) => row.sourceType === sourceType).length,
    }));
}

function buildDuplicateGroups(
  current: StructuredMemoryRecord[]
): MemoryAuditDuplicateGroup[] {
  const duplicateMap = new Map<string, StructuredMemoryRecord[]>();

  for (const row of current) {
    const normalized = normalizeDuplicateText(row.text);
    if (normalized.length < DUPLICATE_NORMALIZED_MIN_LENGTH) {
      continue;
    }

    const group = duplicateMap.get(normalized) ?? [];
    group.push(row);
    duplicateMap.set(normalized, group);
  }

  return Array.from(duplicateMap.values())
    .filter((group) => group.length > 1)
    .sort((a, b) => b.length - a.length)
    .slice(0, 10)
    .map((group) => ({
      text: group[0].text,
      memoryType: group[0].memoryType,
      currentCount: group.length,
      memoryKeys: group.map((item) => item.memoryKey),
    }));
}

function buildStaleGroups(byType: MemoryAuditTypeSummary[]): MemoryAuditStaleGroup[] {
  return byType
    .map((summary) => ({
      memoryType: summary.memoryType,
      newestCurrentAt: summary.newestCurrentAt,
      ageDays: daysOld(summary.newestCurrentAt),
    }))
    .filter((item) => typeof item.ageDays === "number" && item.ageDays > STALE_MEMORY_DAYS)
    .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
}

function buildIssues(params: {
  current: StructuredMemoryRecord[];
  events: StructuredMemoryEventRecord[];
  byType: MemoryAuditTypeSummary[];
  lowQuality: StructuredMemoryRecord[];
  duplicateGroups: MemoryAuditDuplicateGroup[];
  stale: MemoryAuditStaleGroup[];
}): MemoryAuditIssue[] {
  const issues: MemoryAuditIssue[] = [];

  if (params.current.length === 0) {
    issues.push({
      severity: "warning",
      code: "no_current",
      message: "No current structured memories exist yet.",
    });
  }

  if (params.events.length === 0) {
    issues.push({
      severity: "warning",
      code: "no_events",
      message: "No memory events exist yet, so lifecycle history is empty.",
    });
  }

  for (const summary of params.byType) {
    if (summary.currentCount === 0 && summary.eventCount === 0) {
      issues.push({
        severity: summary.memoryType === "seed" ? "info" : "warning",
        code: "missing_type",
        message: `No ${summary.memoryType} memories are present.`,
      });
    }
  }

  for (const group of params.stale.slice(0, 5)) {
    issues.push({
      severity: "warning",
      code: "stale_type",
      message: `${group.memoryType} memories look stale (${Math.round(group.ageDays ?? 0)} days since latest current record).`,
    });
  }

  for (const row of params.lowQuality.slice(0, 5)) {
    issues.push({
      severity: "warning",
      code: "low_quality_memory",
      message: `${row.memoryType} memory "${row.memoryKey}" has a low quality score (${row.qualityScore.toFixed(2)}).`,
    });
  }

  for (const group of params.duplicateGroups.slice(0, 3)) {
    issues.push({
      severity: "warning",
      code: "duplicate_memory",
      message: `${group.memoryType} has ${group.currentCount} near-duplicate current records.`,
    });
  }

  return issues;
}

export async function buildMemoryAudit(
  options: BuildMemoryAuditOptions = {}
): Promise<MemoryAuditResult> {
  const limit = options.limit ?? 500;
  const [current, events, rankedPreview] = await Promise.all([
    getCurrentMemories({ limit }),
    getMemoryEvents({ limit }),
    options.query
      ? getRankedRecallCandidates(options.query, { limit: 8 })
      : Promise.resolve([]),
  ]);

  const byType = buildTypeSummary(current, events);
  const bySource = buildSourceSummary(current, events);
  const lowQuality = current
    .filter((row) => row.qualityScore < LOW_QUALITY_THRESHOLD)
    .sort((a, b) => a.qualityScore - b.qualityScore)
    .slice(0, 20);
  const duplicateGroups = buildDuplicateGroups(current);
  const stale = buildStaleGroups(byType);
  const issues = buildIssues({
    current,
    events,
    byType,
    lowQuality,
    duplicateGroups,
    stale,
  });

  return {
    totals: {
      current: current.length,
      events: events.length,
      typesPresent: byType.filter((item) => item.currentCount > 0 || item.eventCount > 0)
        .length,
      sourceTypesPresent: bySource.length,
    },
    byType,
    bySource,
    issues,
    stale,
    lowQuality,
    duplicateGroups,
    rankedPreview,
  };
}
