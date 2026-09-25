export type PracticeConfidence = "again" | "unsure" | "confident";

export type PracticeOrderingState = {
  card_id: string;
  confidence: PracticeConfidence | null;
  last_reviewed_at: string | null;
};

const rank: Record<PracticeConfidence, number> = {
  again: 0,
  unsure: 2,
  confident: 3,
};

function reviewedAt(value: string | null): number {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

/** Again, unseen, Unsure, Confident; then oldest review and stable card ID. */
export function orderPracticeCards(states: readonly PracticeOrderingState[]): string[] {
  return [...states]
    .sort((left, right) => {
      const confidenceOrder = (left.confidence === null ? 1 : rank[left.confidence])
        - (right.confidence === null ? 1 : rank[right.confidence]);
      if (confidenceOrder !== 0) return confidenceOrder;
      const ageOrder = reviewedAt(left.last_reviewed_at) - reviewedAt(right.last_reviewed_at);
      return ageOrder || left.card_id.localeCompare(right.card_id);
    })
    .map(({ card_id }) => card_id);
}
