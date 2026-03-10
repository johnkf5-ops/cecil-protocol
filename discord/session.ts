import { observe } from "../cecil/observer";
import type { Message } from "../cecil/types";
import { IDLE_TIMEOUT_MS } from "./config";

let lastMessages: Message[] = [];
let idleTimer: NodeJS.Timeout | null = null;
let pendingSessionId: string | null = null;

function sessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Called after every bot response. Runs Cecil observer pipeline in background.
 * Light pass (0 LLM calls) every time. Full synthesis on SYNTHESIS_INTERVAL.
 */
export function onResponse(messages: Message[]): void {
  lastMessages = messages;
  const sid = sessionId();
  pendingSessionId = sid;

  observe(messages, sid)
    .then(({ didSynthesize }) => {
      if (pendingSessionId === sid) {
        lastMessages = [];
        pendingSessionId = null;
      }

      if (didSynthesize) console.log("[cecil] Full synthesis completed");
      else console.log("[cecil] Light pass completed");
    })
    .catch((err) => console.error("[cecil] Observer error:", err));

  resetIdleTimer();
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (lastMessages.length > 0) {
      const sid = sessionId();
      pendingSessionId = sid;
      console.log("[cecil] Idle timeout — running observer");
      observe(lastMessages, sid)
        .then(() => {
          if (pendingSessionId === sid) {
            lastMessages = [];
            pendingSessionId = null;
          }
        })
        .catch((err) => console.error("[cecil] Idle observer error:", err));
    }
  }, IDLE_TIMEOUT_MS);
}
