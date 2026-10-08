import { activeItems, latestVersion } from './idea_state.js';
import type {
  Alternative,
  AnyIdeaItem,
  CollectionName,
  Evidence,
  IdeaCase,
  OpenItem,
} from './schemas.js';

/**
 * Structured context.
 *
 * The model is given a projection of the Idea State, not the conversation.
 * Two consequences matter:
 *
 *  - Ideno's memory is the state, so it does not degrade as a chat grows.
 *  - Every line carries an id and an epistemic status, so the model can refer
 *    to `con-3f20a1b4` precisely and can see what is a fact versus a guess.
 *
 * Recent conversation is included only as a short tail, for pronoun
 * resolution ("the second one"), and is explicitly labelled as such.
 */

export interface ContextOptions {
  /** Hard cap on rendered characters. Sections are trimmed oldest-first. */
  readonly maxChars?: number;
  readonly maxItemsPerCollection?: number;
  readonly maxConversationTurns?: number;
  /** Local refs for items being added in this turn, shown so later stages can cite them. */
  readonly pendingAdditions?: readonly PendingAddition[];
}

export interface PendingAddition {
  readonly ref: string;
  readonly collection: CollectionName;
  readonly text: string;
}

const DEFAULTS = {
  maxChars: 14_000,
  maxItemsPerCollection: 40,
  maxConversationTurns: 6,
} as const;

function statusBadge(item: AnyIdeaItem): string {
  const parts: string[] = [item.epistemic_status, item.origin];
  if (item.confidence !== null && item.confidence !== undefined) {
    parts.push(`conf ${item.confidence.toFixed(2)}`);
  }
  return parts.join(', ');
}

function renderItem(item: AnyIdeaItem): string {
  return `- [${item.id}] (${statusBadge(item)}) ${item.text}`;
}

function renderOpenItem(item: OpenItem): string {
  const blocks = item.blocks.length > 0 ? ` | blocks: ${item.blocks.join(', ')}` : '';
  return `- [${item.id}] (impact ${item.impact.toFixed(2)}, ${statusBadge(item)}) ${item.text}${blocks}`;
}

function renderEvidence(item: Evidence): string {
  const source =
    item.source.type === 'url'
      ? `url ${item.source.url}${item.source.title ? ` ("${item.source.title}")` : ''}`
      : item.source.type === 'user'
        ? `user: ${item.source.description}`
        : `document: ${item.source.name}`;
  return `- [${item.id}] claim: ${item.claim} | source: ${source} | relevance: ${item.relevance}`;
}

function renderAlternative(item: Alternative): string {
  const lines = [`- [${item.id}]${item.selected ? ' ** SELECTED **' : ''} ${item.summary}`];
  lines.push(`    approach: ${item.approach}`);
  if (item.pros.length > 0) lines.push(`    pros: ${item.pros.join('; ')}`);
  if (item.cons.length > 0) lines.push(`    cons: ${item.cons.join('; ')}`);
  if (item.preconditions.length > 0) lines.push(`    requires: ${item.preconditions.join('; ')}`);
  return lines.join('\n');
}

interface Section {
  readonly heading: string;
  readonly lines: readonly string[];
  /** Lower is dropped first when the budget is exceeded. */
  readonly priority: number;
}

function limited<T>(items: readonly T[], max: number): { shown: readonly T[]; omitted: number } {
  if (items.length <= max) return { shown: items, omitted: 0 };
  // Keep the most recent, which are the ones the current turn is about.
  return { shown: items.slice(items.length - max), omitted: items.length - max };
}

function sectionFor<T>(
  heading: string,
  items: readonly T[],
  render: (item: T) => string,
  priority: number,
  max: number,
): Section | null {
  if (items.length === 0) return null;
  const { shown, omitted } = limited(items, max);
  const lines = shown.map(render);
  if (omitted > 0) lines.unshift(`(${omitted} older item(s) omitted)`);
  return { heading: `${heading} (${items.length})`, lines, priority };
}

/** Items Ideno already decided against — listed so they are not re-proposed. */
function closedItems(ideaCase: IdeaCase): string[] {
  const collections: CollectionName[] = [
    'requirements',
    'assumptions',
    'constraints',
    'alternatives',
    'unknowns',
    'open_questions',
  ];
  const lines: string[] = [];
  for (const collection of collections) {
    for (const item of ideaCase[collection] as readonly AnyIdeaItem[]) {
      if (item.status === 'active') continue;
      lines.push(`- [${item.id}] (${item.status}) ${item.text}${item.status_reason ? ` — ${item.status_reason}` : ''}`);
    }
  }
  for (const rejected of ideaCase.rejected_approaches) {
    lines.push(`- [${rejected.id}] (rejected approach) ${rejected.text} — ${rejected.reason}`);
  }
  return lines;
}

export function buildIdeaContext(ideaCase: IdeaCase, options: ContextOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULTS.maxChars;
  const maxItems = options.maxItemsPerCollection ?? DEFAULTS.maxItemsPerCollection;
  const maxTurns = options.maxConversationTurns ?? DEFAULTS.maxConversationTurns;

  const header = [
    '# IDEA CASE',
    `id: ${ideaCase.id}`,
    `title: ${ideaCase.title}`,
    `version: v${latestVersion(ideaCase).index}`,
    `phase: ${ideaCase.current_state.phase}`,
    `original idea (verbatim, never rewrite): ${JSON.stringify(ideaCase.original_idea)}`,
    ideaCase.current_intent ? `current intent: ${ideaCase.current_intent}` : null,
    ideaCase.current_state.summary ? `current state: ${ideaCase.current_state.summary}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const sections: (Section | null)[] = [
    sectionFor('## REQUIREMENTS', activeItems(ideaCase, 'requirements'), renderItem, 9, maxItems),
    sectionFor('## CONSTRAINTS', activeItems(ideaCase, 'constraints'), renderItem, 10, maxItems),
    sectionFor('## ASSUMPTIONS', activeItems(ideaCase, 'assumptions'), renderItem, 8, maxItems),
    sectionFor(
      '## UNKNOWNS',
      [...activeItems(ideaCase, 'unknowns')].sort((a, b) => b.impact - a.impact),
      renderOpenItem,
      7,
      maxItems,
    ),
    sectionFor(
      '## OPEN QUESTIONS',
      [...activeItems(ideaCase, 'open_questions')].sort((a, b) => b.impact - a.impact),
      renderOpenItem,
      6,
      maxItems,
    ),
    sectionFor('## EVIDENCE', activeItems(ideaCase, 'evidence'), renderEvidence, 7, maxItems),
    sectionFor(
      '## RESEARCH ITEMS',
      activeItems(ideaCase, 'research_items'),
      (item) => `- [${item.id}] (${item.research_status}) ${item.question}`,
      4,
      maxItems,
    ),
    sectionFor('## ALTERNATIVES', activeItems(ideaCase, 'alternatives'), renderAlternative, 9, maxItems),
    sectionFor(
      '## DECISIONS',
      activeItems(ideaCase, 'decisions'),
      (item) => `- [${item.id}] ${item.question} → ${item.chosen}`,
      10,
      maxItems,
    ),
    sectionFor(
      '## CLOSED / INVALIDATED (do not re-add)',
      closedItems(ideaCase),
      (line) => line,
      5,
      maxItems,
    ),
    sectionFor(
      '## RELATIONS',
      ideaCase.relations,
      (relation) => `- ${relation.from} --${relation.type}--> ${relation.to}${relation.note ? ` (${relation.note})` : ''}`,
      3,
      maxItems,
    ),
  ];

  const conversation = ideaCase.conversation.slice(-maxTurns);
  if (conversation.length > 0) {
    sections.push({
      heading: '## RECENT CONVERSATION (for pronoun resolution only — the state above is authoritative)',
      lines: conversation.map(
        (turn) => `- ${turn.role}: ${turn.text.length > 600 ? `${turn.text.slice(0, 600)}…` : turn.text}`,
      ),
      priority: 6,
    });
  }

  if (options.pendingAdditions && options.pendingAdditions.length > 0) {
    sections.push({
      heading: '## BEING ADDED THIS TURN (reference these by their @ref)',
      lines: options.pendingAdditions.map(
        (addition) => `- @${addition.ref} (${addition.collection}) ${addition.text}`,
      ),
      priority: 11,
    });
  }

  const present = sections.filter((section): section is Section => section !== null);
  return assemble(header, present, maxChars);
}

/** Joins sections, dropping the lowest-priority ones if the budget is blown. */
function assemble(header: string, sections: readonly Section[], maxChars: number): string {
  const render = (chosen: readonly Section[]): string =>
    [header, ...chosen.map((section) => [section.heading, ...section.lines].join('\n'))].join('\n\n');

  const ordered = [...sections];
  let output = render(ordered);
  while (output.length > maxChars && ordered.length > 0) {
    let lowestIndex = 0;
    for (let index = 1; index < ordered.length; index += 1) {
      if ((ordered[index] as Section).priority < (ordered[lowestIndex] as Section).priority) {
        lowestIndex = index;
      }
    }
    const [dropped] = ordered.splice(lowestIndex, 1);
    output = `${render(ordered)}\n\n(${dropped?.heading ?? 'a section'} omitted to stay within the context budget)`;
  }
  return output;
}
