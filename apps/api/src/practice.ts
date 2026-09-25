import { createHash } from "node:crypto";
import { orderPracticeCards, type Flashcard, type PracticeConfidence } from "@jobber/core";
import { z } from "zod";
import type { KitStore, OwnedKit } from "./kits.js";

export type PracticeReview = {
  id: string;
  confidence: PracticeConfidence;
  reviewedAt: Date;
  cardVersion: string;
};

export type PracticeRecord = {
  ownerId: string;
  kitId: string;
  cardId: string;
  cardVersion: string;
  confidence: PracticeConfidence;
  reviewCount: number;
  lastReviewedAt: Date;
  reviews: PracticeReview[];
};

export interface PracticeStore {
  listPracticeRecords(ownerId: string, kitId: string): Promise<PracticeRecord[]>;
  recordPracticeReview(input: {
    ownerId: string;
    kitId: string;
    cardId: string;
    cardVersion: string;
    reviewId: string;
    confidence: PracticeConfidence;
    now: Date;
  }): Promise<PracticeRecord>;
}

const reviewSchema = z.strictObject({
  review_id: z.string().uuid(),
  card_id: z.string().min(1),
  confidence: z.enum(["again", "unsure", "confident"]),
});

export class PracticeError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "PracticeError";
  }
}

function cardVersion(card: Flashcard): string {
  return createHash("sha256").update(JSON.stringify({
    front: card.front,
    back: card.back,
    requirement_ids: card.requirement_ids,
  })).digest("hex");
}

function snapshot(kit: OwnedKit, records: readonly PracticeRecord[]) {
  const recordsByCard = new Map(records.map((record) => [record.cardId, record]));
  const progress = kit.content.flashcards.map((card) => {
    const record = recordsByCard.get(card.id);
    const current = Boolean(record && record.cardVersion === cardVersion(card));
    return {
      cardId: card.id,
      confidence: current ? record!.confidence : null,
      reviewCount: record?.reviewCount ?? 0,
      lastReviewedAt: record?.lastReviewedAt.toISOString() ?? null,
    };
  });
  const unseen = progress.filter(({ confidence }) => confidence === null).length;
  return {
    kitId: kit.id,
    progress,
    orderedCardIds: orderPracticeCards(progress.map((item) => ({
      card_id: item.cardId,
      confidence: item.confidence,
      last_reviewed_at: item.lastReviewedAt,
    }))),
    counts: { unseen, reviewed: progress.length - unseen, total: progress.length },
  };
}

export class PracticeService {
  constructor(private readonly store: KitStore & PracticeStore) {}

  async get(ownerId: string, kitId: string) {
    const kit = await this.store.findOwnedKit(ownerId, kitId);
    if (!kit) throw new PracticeError("NOT_FOUND", 404, "Kit not found.");
    return snapshot(kit, await this.store.listPracticeRecords(ownerId, kitId));
  }

  async review(ownerId: string, kitId: string, body: unknown, now = new Date()) {
    const parsed = reviewSchema.safeParse(body);
    if (!parsed.success) throw new PracticeError("INVALID_PRACTICE_REVIEW", 400, "Choose a valid card and confidence level.");
    const kit = await this.store.findOwnedKit(ownerId, kitId);
    if (!kit) throw new PracticeError("NOT_FOUND", 404, "Kit not found.");
    const card = kit.content.flashcards.find(({ id }) => id === parsed.data.card_id);
    if (!card) throw new PracticeError("CARD_NOT_FOUND", 404, "This flashcard is no longer available.");
    await this.store.recordPracticeReview({
      ownerId,
      kitId,
      cardId: card.id,
      cardVersion: cardVersion(card),
      reviewId: parsed.data.review_id,
      confidence: parsed.data.confidence,
      now,
    });
    return snapshot(kit, await this.store.listPracticeRecords(ownerId, kitId));
  }
}
