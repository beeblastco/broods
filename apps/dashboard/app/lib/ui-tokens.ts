/**
 * Shared UI style tokens for consistent accent colors and interactive states.
 * Compose these into className strings via cn().
 */

/**
 * Cyan-tinted option card — used for any "selected choice" card in the UI.
 * Example: environment init mode selector, plan/tier cards, toggle groups.
 */
export const selectionCard = {
    active: "border-cyan-500 bg-cyan-500/10",
    inactive: "border-border hover:bg-accent/50",
} as const;

