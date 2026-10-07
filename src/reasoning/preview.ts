/**
 * Describing a response that is still arriving.
 *
 * When a model streams, the user is otherwise staring at a spinner for the ten
 * seconds it takes to produce a few hundred words of JSON. This module turns the
 * partial document into one honest sentence: "adding 2 constraints and 1 unknown".
 *
 * Two rules keep it honest:
 *
 *  1. It only ever reports what the partial document *already contains*. Nothing is
 *     inferred about what is coming, and a field that has not arrived is not
 *     mentioned.
 *  2. Its output is decoration. It never decides anything, never reaches the Idea
 *     State, and is discarded the moment the real response validates. The word
 *     "proposed" is used rather than "added", because at that point nothing has been
 *     added and the human has not reviewed anything.
 */
import { CHANGE_SET_KEYS } from '../core/schemas/index.js';

/** How many items of each kind to name before falling back to a count. */
const MAX_NAMED_ITEMS = 3;

/**
 * Change-set keys whose value is a sentence rather than a list.
 *
 * Naming them explicitly matters: without this, a malformed document that put a
 * string where an array belongs (`constraints_added: "..."`) would be counted as a
 * scalar revision and reported as "proposing constraint", which describes something
 * that is not there.
 */
const SCALAR_CHANGE_KEYS = new Set(['title', 'current_intent']);

/**
 * Wording per change-set key. The brief's own vocabulary is used where it has one:
 * a constraint is *added*, an assumption is *recorded*, an unknown is *named*.
 */
const CHANGE_SET_WORDING: Partial<Record<(typeof CHANGE_SET_KEYS)[number], string>> = {
  title: 'restating the title',
  current_intent: 'restating the goal',
  requirements_added: 'requirement',
  assumptions_added: 'assumption',
  constraints_added: 'constraint',
  unknowns_added: 'unknown',
  evidence_added: 'evidence record',
  research_items_added: 'research question',
  alternatives_added: 'alternative',
  decisions_added: 'decision',
  rejected_approaches_added: 'rejected approach',
  open_questions_added: 'open question',
  findings_added: 'critique finding',
};

/**
 * A one-line description of a partially received turn plan.
 *
 * @param partial the best-effort parse of the text so far (see `parsePartialJson`)
 * @param complete whether the document had finished arriving
 * @returns null when there is nothing worth saying yet
 */
export function describePartialPlan(partial: unknown, complete: boolean): string | null {
  if (!isRecord(partial)) return null;

  const parts: string[] = [];
  const changes = isRecord(partial.changes) ? partial.changes : null;

  if (changes) {
    for (const key of CHANGE_SET_KEYS) {
      const value = changes[key];
      if (Array.isArray(value) && value.length > 0) {
        const wording = CHANGE_SET_WORDING[key];
        if (!wording) continue;
        parts.push(`${value.length} ${wording}${value.length === 1 ? '' : 's'}`);
      } else if (SCALAR_CHANGE_KEYS.has(key) && typeof value === 'string' && value.trim().length > 0) {
        const wording = CHANGE_SET_WORDING[key];
        if (wording) parts.push(wording);
      }
    }
  }

  const question = isRecord(partial.question) ? partial.question : null;
  if (question && typeof question.text === 'string' && question.text.trim().length > 0) {
    parts.push('one question');
  }

  const userMessage = typeof partial.user_message === 'string' ? partial.user_message.trim() : '';

  if (parts.length === 0 && userMessage.length === 0) return null;

  if (parts.length === 0) {
    return complete ? 'Writing a reply.' : 'Writing a reply…';
  }

  const proposal = parts.slice(0, MAX_NAMED_ITEMS).join(', ');
  const extra = parts.length > MAX_NAMED_ITEMS ? ` (+${parts.length - MAX_NAMED_ITEMS} more)` : '';
  return complete
    ? `Proposed ${proposal}${extra}.`
    : `Proposing ${proposal}${extra}…`;
}

/**
 * The first sentence of a reply as it arrives, for showing something readable before
 * the whole turn is validated.
 *
 * Deliberately returns the *raw* prefix rather than anything interpreted: it is the
 * model's own wording, and Ideno has not accepted it yet, so it is marked as such by
 * the caller rather than presented as Ideno's reply.
 */
export function partialReplyPreview(partial: unknown, maxLength = 240): string | null {
  if (!isRecord(partial)) return null;
  const message = typeof partial.user_message === 'string' ? partial.user_message.trim() : '';
  if (message.length === 0) return null;
  return message.length <= maxLength ? message : `${message.slice(0, maxLength)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
