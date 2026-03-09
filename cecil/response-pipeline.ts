import { deepSearch } from "./deep-search";
import { chatCompletion } from "./llm";
import type { Message } from "./types";

interface GenerateResponseOptions {
  messages: Message[];
  maxTokens?: number;
  deepSearchEnabled?: boolean;
  buildInitialPrompt: (conversationContext: string) => Promise<string>;
  buildDeepSearchPrompt: (
    conversationContext: string,
    searchResults: string
  ) => Promise<string>;
  noResultsResponse: string;
}

interface GenerateResponseResult {
  response: string;
  usedDeepSearch: boolean;
}

function getConversationContext(messages: Message[]): string {
  return messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
}

function extractSearchQuery(response: string): string | null {
  const match = response.match(/^\[SEARCH:\s*([\s\S]+?)\]$/);
  return match ? match[1].trim() : null;
}

export async function generateResponse(
  options: GenerateResponseOptions
): Promise<GenerateResponseResult> {
  const conversationContext = getConversationContext(options.messages);
  const initialPrompt = await options.buildInitialPrompt(conversationContext);

  const firstResponse = await chatCompletion({
    system: initialPrompt,
    messages: options.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    maxTokens: options.maxTokens ?? 2048,
  });

  if (!options.deepSearchEnabled) {
    return {
      response: firstResponse,
      usedDeepSearch: false,
    };
  }

  const searchQuery = extractSearchQuery(firstResponse.trim());
  if (!searchQuery) {
    return {
      response: firstResponse,
      usedDeepSearch: false,
    };
  }

  const deepSearchResult = await deepSearch(searchQuery);
  if (deepSearchResult.results.length === 0) {
    return {
      response: options.noResultsResponse,
      usedDeepSearch: true,
    };
  }

  const deepSearchPrompt = await options.buildDeepSearchPrompt(
    conversationContext,
    deepSearchResult.formattedContext
  );

  const finalResponse = await chatCompletion({
    system: deepSearchPrompt,
    messages: options.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    maxTokens: options.maxTokens ?? 2048,
  });

  return {
    response: finalResponse,
    usedDeepSearch: true,
  };
}
