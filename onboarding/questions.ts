export interface OnboardingQuestion {
  id: keyof import("@/cecil/types").OnboardingAnswers;
  question: string;
  placeholder: string;
}

export const ONBOARDING_QUESTIONS: OnboardingQuestion[] = [
  {
    id: "name",
    question: "What should I call you?",
    placeholder: "Your name",
  },
  {
    id: "age",
    question: "How old are you?",
    placeholder: "Your age",
  },
  {
    id: "location",
    question: "Where are you based?",
    placeholder: "City, country, etc.",
  },
  {
    id: "occupation",
    question: "What do you do?",
    placeholder: "Your work, craft, or focus",
  },
  {
    id: "currentGoal",
    question: "What are you working toward right now?",
    placeholder: "A goal, project, or direction",
  },
];
