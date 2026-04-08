export type MemoryType =
  | "conversation"
  | "observation"
  | "milestone"
  | "seed"
  | "podcast"
  | "fact";

export type MemoryDomain =
  | "technology"
  | "business"
  | "personal"
  | "creative"
  | "health"
  | "education"
  | "finance"
  | "entertainment"
  | "general";

export type MemorySourceType =
  | "onboarding"
  | "conversation_session"
  | "observer_synthesis"
  | "podcast_ingest"
  | "fact_extraction"
  | "direct_correction"
  | "unknown";

export interface MemoryMetadata {
  type: MemoryType;
  timestamp: string;
  sessionId?: string;
  sourcePath?: string;
  sourceType?: MemorySourceType;
  sourceId?: string;
  sourceEpisode?: string;
  entities?: string[];
  category?: string;
  domain?: string;
  qualityScore?: number;
  provenance?: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  text: string;
  score: number;
  metadata: MemoryMetadata;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface SessionCounter {
  count: number;
  lastFullSynthesis: number;
}

export interface OnboardingAnswers {
  name: string;
  age: string;
  location: string;
  occupation: string;
  currentGoal: string;
}
