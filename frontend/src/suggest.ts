const suggestionCache = new Map<string, string[]>();

export interface SuggestionItem {
  term: string;
  distance: number;
  count?: number;
}

export interface SuggestionResponse {
  word: string;
  suggestions: SuggestionItem[];
}

export function matchCase(original: string, terms: string[]): string[] {
  if (terms.length === 0) return [];
  const first = original[0];
  const allCaps = original.length > 1 && original === original.toUpperCase();
  const capitalized = first !== first.toLowerCase();

  return terms.map((term) => {
    if (allCaps) return term.toUpperCase();
    if (capitalized) return term.charAt(0).toUpperCase() + term.slice(1);
    return term;
  });
}

export async function fetchSuggestions(word: string, signal?: AbortSignal): Promise<string[]> {
  const key = word.trim().toLowerCase();
  if (!key) return [];

  const cached = suggestionCache.get(key);
  if (cached) {
    return matchCase(word, cached);
  }

  try {
    const res = await fetch(`/api/suggest?word=${encodeURIComponent(key)}`, { signal });
    if (!res.ok) {
      throw new Error(`Suggest API error: HTTP ${res.status}`);
    }
    const data: SuggestionResponse = await res.json();
    const terms = (data.suggestions || []).map((s) => s.term);
    suggestionCache.set(key, terms);
    return matchCase(word, terms);
  } catch (err: unknown) {
    if ((err as Error).name === "AbortError") {
      throw err;
    }
    console.error("Failed to fetch suggestions:", err);
    return [];
  }
}
