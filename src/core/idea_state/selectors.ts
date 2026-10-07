/**
 * Derived views over the Idea State.
 *
 * Nothing here mutates anything. `deriveCurrentState` is deliberately
 * deterministic and computed from the data — the phase badge can therefore never
 * disagree with the state it summarises, and no model gets to declare "we are
 * done" on its own authority.
 */
import {
  IMPACT_RANK,
  type Alternative,
  type Finding,
  type IdeaCaseBody,
  type IdeaPhase,
  type Question,
  type Unknown,
} from '../schemas/index.js';
import { COLLECTIONS, isClosed, type CollectionName } from './collections.js';

/**
 * Lifecycle position of an idea, derived from its contents.
 *
 * Precedence:
 *  1. an unresolved critical finding    -> blocked
 *  2. nothing analysed yet              -> seed
 *  3. alternative chosen + decisions    -> decided (unless big unknowns remain)
 *  4. a choice or decision exists       -> refining
 *  5. two or more live alternatives,    -> exploring
 *     none chosen
 *  6. otherwise                         -> structuring
 *
 * A critical finding outranks everything because it is the one signal the user
 * must see immediately: continuing to describe the idea as "just a seed" would
 * hide a contradiction Ideno has already spotted.
 */
export function deriveCurrentState(body: IdeaCaseBody): IdeaPhase {
  const blocked = body.findings.some(
    (finding) => finding.severity === 'critical' && finding.status === 'open',
  );
  if (blocked) return 'blocked';

  // "Structured" means Ideno has recorded any analysis at all, not only
  // requirements: unknowns and assumptions are structure too.
  const hasStructure =
    body.requirements.length > 0 ||
    body.constraints.length > 0 ||
    body.alternatives.length > 0 ||
    body.assumptions.length > 0 ||
    body.unknowns.length > 0;
  if (!hasStructure) return 'seed';

  const selected = body.selected_alternative_id
    ? body.alternatives.find((alternative) => alternative.id === body.selected_alternative_id) ?? null
    : null;
  const openHighImpactUnknowns = body.unknowns.filter(
    (unknown) => unknown.status === 'open' && unknown.impact === 'high',
  ).length;
  const activeDecisions = body.decisions.filter((decision) => decision.status === 'active').length;

  if (selected && activeDecisions > 0 && openHighImpactUnknowns === 0) return 'decided';
  if (selected || activeDecisions > 0) return 'refining';
  if (body.alternatives.filter((alternative) => alternative.status !== 'rejected').length >= 2) {
    return 'exploring';
  }
  return 'structuring';
}

export interface CollectionCount {
  total: number;
  open: number;
}

export interface IdeaStats {
  phase: IdeaPhase;
  counts: Record<CollectionName, CollectionCount>;
  open_high_impact_unknowns: number;
  open_critical_findings: number;
  selected_alternative: Alternative | null;
  /** Total items whose provenance is not grounded in the user or evidence. */
  model_contributed: number;
}

export function computeStats(body: IdeaCaseBody): IdeaStats {
  const counts = {} as Record<CollectionName, CollectionCount>;
  let modelContributed = 0;

  for (const collection of COLLECTIONS) {
    const items = body[collection] as { status?: string; provenance?: string }[];
    counts[collection] = {
      total: items.length,
      open: items.filter((item) => !isClosed(item)).length,
    };
    modelContributed += items.filter(
      (item) => item.provenance === 'model_inferred' || item.provenance === 'model_suggestion',
    ).length;
  }

  return {
    phase: deriveCurrentState(body),
    counts,
    open_high_impact_unknowns: body.unknowns.filter(
      (unknown) => unknown.status === 'open' && unknown.impact === 'high',
    ).length,
    open_critical_findings: body.findings.filter(
      (finding) => finding.status === 'open' && finding.severity === 'critical',
    ).length,
    selected_alternative: body.selected_alternative_id
      ? body.alternatives.find((alternative) => alternative.id === body.selected_alternative_id) ?? null
      : null,
    model_contributed: modelContributed,
  };
}

/**
 * Open unknowns, most design-changing first. Impact dominates; the number of
 * areas an unknown blocks breaks ties, then age.
 */
export function rankUnknowns(body: IdeaCaseBody): Unknown[] {
  return body.unknowns
    .filter((unknown) => unknown.status === 'open')
    .slice()
    .sort((a, b) => {
      const byImpact = IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact];
      if (byImpact !== 0) return byImpact;
      const byReach = b.affected_areas.length - a.affected_areas.length;
      if (byReach !== 0) return byReach;
      return a.created_at.localeCompare(b.created_at);
    });
}

export function openFindings(body: IdeaCaseBody): Finding[] {
  return body.findings.filter((finding) => finding.status === 'open');
}

export interface QuestionDecision {
  question: Question;
  /** Why the question was suppressed, when it was. */
  suppressed_reason?: undefined;
}

export interface QuestionSuppressed {
  question: null;
  suppressed_reason: string;
}

/**
 * Enforces Ideno's questioning discipline in code rather than trusting a prompt:
 * at most one question per turn, and never a low-impact one.
 *
 * A question is suppressed when:
 *  - it is rated low impact (it would be interrogation, not development),
 *  - it points at an unknown that is already resolved,
 *  - the same question was already asked and not answered.
 */
export function decideQuestion(
  body: IdeaCaseBody,
  proposed: Question | null,
): QuestionDecision | QuestionSuppressed {
  if (!proposed) return { question: null, suppressed_reason: 'The model proposed no question.' };

  if (proposed.impact === 'low') {
    return {
      question: null,
      suppressed_reason: 'Suppressed: rated low impact, so it would not change the design.',
    };
  }

  if (proposed.unknown_id) {
    const unknown = body.unknowns.find((item) => item.id === proposed.unknown_id);
    if (unknown && unknown.status !== 'open') {
      return {
        question: null,
        suppressed_reason: `Suppressed: unknown ${unknown.id} is already ${unknown.status}.`,
      };
    }
  }

  const normalized = proposed.text.trim().toLowerCase();
  const alreadyAsked = body.open_questions.some(
    (item) => item.status === 'asked' && item.question.trim().toLowerCase() === normalized,
  );
  if (alreadyAsked) {
    return { question: null, suppressed_reason: 'Suppressed: this question was already asked.' };
  }

  return { question: proposed };
}
