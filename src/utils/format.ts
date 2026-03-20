/**
 * Shared formatting utilities
 * ARCHITECTURE: Centralized string formatting to eliminate inline duplication
 */

/**
 * Truncate a string to maxLen characters, appending '...' if truncated
 * @param text The string to truncate
 * @param maxLen Maximum length before truncation (default: 50)
 * @returns The original string if within limit, or truncated with '...' suffix
 */
export function truncatePrompt(text: string, maxLen = 50): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}
