// Meeting state machine — in-memory singleton

import { AGENT_IDS, MEETING_AGENT_ORDER } from "./config";

export interface MeetingState {
  active: boolean;
  topic: string;
  round: number;
  agentIndex: number; // which agent just got tagged (0-3)
  closingRound: boolean;
  awaitingApproval: boolean;
  specDraft: string | null;
}

let meeting: MeetingState | null = null;

export function startMeeting(topic: string): MeetingState {
  meeting = {
    active: true,
    topic,
    round: 1,
    agentIndex: 0,
    closingRound: false,
    awaitingApproval: false,
    specDraft: null,
  };
  return meeting;
}

/** Get the current agent being waited on */
export function currentAgent(): { name: string; id: string } | null {
  if (!meeting) return null;
  const name = MEETING_AGENT_ORDER[meeting.agentIndex];
  return { name, id: AGENT_IDS[name] };
}

/** Get the next agent to tag. Returns null if closing round. */
export function nextAgent(): { name: string; id: string } | null {
  if (!meeting || meeting.closingRound || meeting.awaitingApproval) return null;

  const nextIndex = meeting.agentIndex + 1;

  // Past last agent in this round
  if (nextIndex >= MEETING_AGENT_ORDER.length) {
    const nextRound = meeting.round + 1;
    if (nextRound > 3) {
      // 3 rounds done — trigger closing
      return null;
    }
    // Next round, first agent
    return { name: MEETING_AGENT_ORDER[0], id: AGENT_IDS[MEETING_AGENT_ORDER[0]] };
  }

  return { name: MEETING_AGENT_ORDER[nextIndex], id: AGENT_IDS[MEETING_AGENT_ORDER[nextIndex]] };
}

/** Advance to next agent. Increments round when wrapping. Returns true if meeting should close. */
export function advanceAgent(): boolean {
  if (!meeting) return true;

  meeting.agentIndex++;

  if (meeting.agentIndex >= MEETING_AGENT_ORDER.length) {
    meeting.agentIndex = 0;
    meeting.round++;

    if (meeting.round > 3) {
      meeting.closingRound = true;
      return true; // signal: time to close
    }
  }

  return false;
}

/** Get the first agent (for meeting opening) */
export function firstAgent(): { name: string; id: string } {
  const name = MEETING_AGENT_ORDER[0];
  return { name, id: AGENT_IDS[name] };
}

export function setClosingRound(): void {
  if (meeting) meeting.closingRound = true;
}

export function setAwaitingApproval(): void {
  if (meeting) meeting.awaitingApproval = true;
}

export function getMeeting(): MeetingState | null {
  return meeting;
}

export function endMeeting(): void {
  meeting = null;
}
