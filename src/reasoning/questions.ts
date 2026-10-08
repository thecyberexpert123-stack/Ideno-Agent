import { activeItems, latestVersion } from '../core/idea_state.js';
import type { IdeaCase, OpenItem } from '../core/schemas.js';

/**
 * Question selection.
 *
 * Ideno asks at most one question per turn, and only when the answer would
 * actually change the design. This is deliberately deterministic rather than
 * another model call: "which gap matters most" is a ranking over data Ideno
 * already has, and keeping it in code makes the behaviour predictable and
 * testable instead of a different mood every turn.
 */

/** Below this score, proceeding without asking is the better behaviour. */
export const ASK_THRESHOLD = 0.45;

const WEIGHTS = {
  blocksSomething: 0.15,
  raisedRecently: 0.1,
  alreadyAsked: -0.5,
  evidenceBacked: -0.2,
} as const;

export interface QuestionCandidate {
  readonly item: OpenItem;
  readonly score: number;
  readonly reasons: readonly string[];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** True when Ideno has already put this question to the user. */
export function alreadyAsked(ideaCase: IdeaCase, item: OpenItem): boolean {
  const needle = normalize(item.text).slice(0, 48);
  if (needle.length < 12) return false;
  return ideaCase.conversation.some(
    (turn) => turn.role === 'ideno' && normalize(turn.text).includes(needle),
  );
}

export function rankQuestions(ideaCase: IdeaCase): QuestionCandidate[] {
  const currentVersion = latestVersion(ideaCase).index;
  const candidates: OpenItem[] = [
    ...activeItems(ideaCase, 'open_questions'),
    ...activeItems(ideaCase, 'unknowns'),
  ];

  return candidates
    .map((item) => {
      const reasons: string[] = [`impact ${item.impact.toFixed(2)}`];
      let score = item.impact;

      if (item.blocks.length > 0) {
        score += WEIGHTS.blocksSomething;
        reasons.push(`blocks ${item.blocks.join(', ')}`);
      }
      if (currentVersion - item.created_in_version <= 1) {
        score += WEIGHTS.raisedRecently;
        reasons.push('raised recently');
      }
      if (item.supported_by.length > 0) {
        score += WEIGHTS.evidenceBacked;
        reasons.push('partly covered by evidence');
      }
      if (alreadyAsked(ideaCase, item)) {
        score += WEIGHTS.alreadyAsked;
        reasons.push('already asked');
      }

      return { item, score: Math.max(0, Math.min(1.5, score)), reasons };
    })
    .sort((a, b) => b.score - a.score || b.item.impact - a.item.impact);
}

/**
 * The single question worth asking right now, or null when Ideno has enough
 * to proceed.
 */
export function selectQuestion(ideaCase: IdeaCase): QuestionCandidate | null {
  const [best] = rankQuestions(ideaCase);
  if (!best || best.score < ASK_THRESHOLD) return null;
  return best;
}
