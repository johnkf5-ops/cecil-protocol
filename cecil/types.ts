export type MemoryType = "conversation" | "observation" | "milestone" | "seed" | "podcast";

export interface MemoryMetadata {
  type: MemoryType;
  timestamp: string;
  sessionId?: string;
  sourcePath?: string;
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
