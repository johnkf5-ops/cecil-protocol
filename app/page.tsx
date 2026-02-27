"use client";

import { useState, useEffect, useRef } from "react";
import { ONBOARDING_QUESTIONS } from "@/onboarding/questions";
import type { Message, OnboardingAnswers } from "@/echo/types";

type AppState = "loading" | "onboarding" | "chat";

function generateSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export default function Home() {
  const [appState, setAppState] = useState<AppState>("loading");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState(() => generateSessionId());
  const [isSending, setIsSending] = useState(false);
  const [isReflecting, setIsReflecting] = useState(false);
  const [reflectStatus, setReflectStatus] = useState<string | null>(null);

  // Onboarding state
  const [onboardStep, setOnboardStep] = useState(0);
  const [onboardAnswers, setOnboardAnswers] = useState<Partial<OnboardingAnswers>>({});
  const [onboardInput, setOnboardInput] = useState("");
  const [isSubmittingOnboard, setIsSubmittingOnboard] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((data) => {
        setAppState(data.onboarded ? "chat" : "onboarding");
      });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // --- Onboarding ---

  async function handleOnboardAnswer() {
    const question = ONBOARDING_QUESTIONS[onboardStep];
    const answer = onboardInput.trim();
    if (!answer) return;

    const updated = { ...onboardAnswers, [question.id]: answer };
    setOnboardAnswers(updated);
    setOnboardInput("");

    if (onboardStep < ONBOARDING_QUESTIONS.length - 1) {
      setOnboardStep(onboardStep + 1);
      return;
    }

    // All questions answered — submit
    setIsSubmittingOnboard(true);
    try {
      const res = await fetch("/api/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      if (res.ok) {
        setAppState("chat");
      }
    } finally {
      setIsSubmittingOnboard(false);
    }
  }

  // --- Chat ---

  async function handleSend() {
    const text = input.trim();
    if (!text || isSending) return;

    const userMessage: Message = { role: "user", content: text };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setIsSending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updatedMessages }),
      });
      const data = await res.json();
      if (data.response) {
        setMessages([...updatedMessages, { role: "assistant", content: data.response }]);
      }
    } finally {
      setIsSending(false);
    }
  }

  async function handleEndSession() {
    if (messages.length === 0 || isReflecting) return;

    setIsReflecting(true);
    setReflectStatus("Saving session...");

    try {
      const res = await fetch("/api/observe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, sessionId }),
      });
      const data = await res.json();

      if (data.didSynthesize) {
        setReflectStatus("Full synthesis complete — narrative and delta updated.");
      } else {
        setReflectStatus("Session logged. Synthesis runs every few sessions.");
      }

      setTimeout(() => {
        setMessages([]);
        setSessionId(generateSessionId());
        setReflectStatus(null);
        setIsReflecting(false);
      }, 2500);
    } catch {
      setReflectStatus("Observer failed.");
      setIsReflecting(false);
    }
  }

  // --- Render ---

  if (appState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-zinc-500 text-sm">
        loading...
      </div>
    );
  }

  if (appState === "onboarding") {
    const question = ONBOARDING_QUESTIONS[onboardStep];
    const progress = onboardStep / ONBOARDING_QUESTIONS.length;

    return (
      <div className="flex min-h-screen items-center justify-center bg-black px-6">
        <div className="w-full max-w-lg">
          <div className="mb-10">
            <p className="text-zinc-600 text-xs mb-2 font-mono">
              echo — {onboardStep + 1} / {ONBOARDING_QUESTIONS.length}
            </p>
            <div className="w-full h-px bg-zinc-800">
              <div
                className="h-px bg-zinc-500 transition-all duration-500"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          </div>

          <h2 className="text-white text-2xl font-light mb-8">
            {question.question}
          </h2>

          <div className="flex gap-3">
            <input
              autoFocus
              type="text"
              value={onboardInput}
              onChange={(e) => setOnboardInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleOnboardAnswer()}
              placeholder={question.placeholder}
              className="flex-1 bg-zinc-900 border border-zinc-800 text-white placeholder-zinc-600 px-4 py-3 rounded-lg text-sm focus:outline-none focus:border-zinc-600"
              disabled={isSubmittingOnboard}
            />
            <button
              onClick={handleOnboardAnswer}
              disabled={!onboardInput.trim() || isSubmittingOnboard}
              className="px-4 py-3 bg-white text-black text-sm rounded-lg disabled:opacity-30 hover:bg-zinc-100 transition-colors"
            >
              {onboardStep < ONBOARDING_QUESTIONS.length - 1 ? "Next" : isSubmittingOnboard ? "..." : "Done"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-black">
      {/* Header */}
      <div className="border-b border-zinc-900 px-6 py-4 flex items-center justify-between">
        <span className="text-zinc-400 text-sm font-mono">echo</span>
        <button
          onClick={handleEndSession}
          disabled={messages.length === 0 || isReflecting}
          className="text-xs text-zinc-600 hover:text-zinc-400 disabled:opacity-30 transition-colors"
        >
          {isReflecting ? reflectStatus : "end session"}
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-8 max-w-3xl mx-auto w-full">
        {messages.length === 0 && (
          <p className="text-zinc-700 text-sm text-center mt-16">
            Start talking. Echo remembers.
          </p>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`mb-6 ${msg.role === "user" ? "text-right" : "text-left"}`}
          >
            <div
              className={`inline-block max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-zinc-800 text-white"
                  : "bg-zinc-900 text-zinc-200"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {isSending && (
          <div className="mb-6 text-left">
            <div className="inline-block px-4 py-3 rounded-2xl bg-zinc-900 text-zinc-500 text-sm">
              ...
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-zinc-900 px-6 py-4 max-w-3xl mx-auto w-full">
        <div className="flex gap-3">
          <input
            autoFocus
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Say something..."
            className="flex-1 bg-zinc-900 border border-zinc-800 text-white placeholder-zinc-600 px-4 py-3 rounded-lg text-sm focus:outline-none focus:border-zinc-700"
            disabled={isSending}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isSending}
            className="px-4 py-3 bg-white text-black text-sm rounded-lg disabled:opacity-30 hover:bg-zinc-100 transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
