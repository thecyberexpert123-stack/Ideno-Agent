/**
 * Turning validated change records into Idea State.
 *
 * Two functions matter here:
 *
 *  - `buildChangeRecords`: converts a validated `ChangeSet` into individual,
 *    individually-reviewable `ChangeRecord`s. Core mints every id in advance,
 *    resolves cross-references, and downgrades any claim it cannot substantiate.
 *  - `applyRecords`: writes records into a *clone* of the state, one record at a
 *    time, skipping (and reporting) any record that cannot be applied cleanly.
 *
 * The caller then re-validates the whole body with `validateBody` before
 * committing, so the Idea State is schema-valid by construction: a bad record
 * costs at most that record, never the state.
 */
import type {
  AnyItemStatus,
  ChangeKind,
  ChangeRecord,
  ChangeSet,
  ChangeSetInput,
  IdeaCaseBody,
  ItemInvalidation,
  ItemUpdate,
  ModelClaimableProvenance,
  OriginOperation,
  Provenance,
  VersionRecord,
} from '../schemas/index.js';
import {
  AffectedSchema,
  AnyItemStatusSchema,
  ChangeRecordSchema,
  ChangeSetSchema,
  DRAFT_SCHEMA_FOR_KIND,
  IdeaCaseBodySchema,
  formatZodIssues,
  formatZodIssuesInline,
} from '../schemas/index.js';
import { newId, type Clock } from '../ids.js';
import { IdenoStateError } from '../errors.js';
import {
  COLLECTIONS,
  TERMINAL_STATUS,
  itemIds,
  parseItem,
  type CollectionName,
} from '../idea_state/collections.js';

/** Change kinds that add an item, and where that item lands. */
export const ADD_KIND_TO_COLLECTION: Partial<Record<ChangeKind, CollectionName>> = {
  requirement_added: 'requirements',
  assumption_added: 'assumptions',
  constraint_added: 'constraints',
  unknown_added: 'unknowns',
  evidence_added: 'evidence',
  research_item_added: 'research_items',
  alternative_added: 'alternatives',
  decision_added: 'decisions',
  rejected_approach_added: 'rejected_approaches',
  open_question_added: 'open_questions',
  finding_added: 'findings',
};

/** Mirrors the `.max()` limits in `IdeaCaseBodySchema` (asserted in tests). */
export const COLLECTION_LIMITS: Record<CollectionName, number> = {
  requirements: 200,
  assumptions: 200,
  constraints: 200,
  unknowns: 200,
  evidence: 200,
  research_items: 200,
  alternatives: 60,
  decisions: 200,
  rejected_approaches: 200,
  open_questions: 200,
  findings: 200,
};

/** The field holding an item's primary text, per collection. */
export const PRIMARY_TEXT_FIELD: Record<CollectionName, string> = {
  requirements: 'text',
  assumptions: 'text',
  constraints: 'text',
  unknowns: 'text',
  evidence: 'claim',
  research_items: 'question',
  alternatives: 'summary',
  decisions: 'text',
  rejected_approaches: 'reason',
  open_questions: 'question',
  findings: 'text',
};

/** Order in which a change set is decomposed. Fixed, so records are stable. */
const CHANGE_SET_ORDER: { key: keyof ChangeSet; kind: ChangeKind }[] = [
  { key: 'title', kind: 'title_revised' },
  { key: 'current_intent', kind: 'intent_revised' },
  { key: 'requirements_added', kind: 'requirement_added' },
  { key: 'assumptions_added', kind: 'assumption_added' },
  { key: 'constraints_added', kind: 'constraint_added' },
  { key: 'unknowns_added', kind: 'unknown_added' },
  { key: 'evidence_added', kind: 'evidence_added' },
  { key: 'research_items_added', kind: 'research_item_added' },
  { key: 'alternatives_added', kind: 'alternative_added' },
  { key: 'decisions_added', kind: 'decision_added' },
  { key: 'rejected_approaches_added', kind: 'rejected_approach_added' },
  { key: 'open_questions_added', kind: 'open_question_added' },
  { key: 'findings_added', kind: 'finding_added' },
  { key: 'selected_alternative_id', kind: 'alternative_selected' },
];

const ID_PREFIX: Partial<Record<ChangeKind, string>> = {
  requirement_added: 'req',
  assumption_added: 'asm',
  constraint_added: 'con',
  unknown_added: 'unk',
  evidence_added: 'evd',
  research_item_added: 'res',
  alternative_added: 'alt',
  decision_added: 'dec',
  rejected_approach_added: 'rej',
  open_question_added: 'q',
  finding_added: 'fnd',
};

export interface BuildChangeRecordsInput {
  changeset: ChangeSetInput;
  body: IdeaCaseBody;
  origin: OriginOperation;
  message_id: string | null;
  rationale?: string;
  clock: Clock;
}

export interface BuildChangeRecordsResult {
  records: ChangeRecord[];
  /** Integrity downgrades: references dropped, claims weakened. Never silent. */
  notes: string[];
}

type StagedScalar = { kind: ChangeKind; scalar: string | null };
type StagedDraft = { kind: ChangeKind; draft: Record<string, unknown>; mintedId: string };
type Staged = StagedScalar | StagedDraft;

function isStagedDraft(staged: Staged): staged is StagedDraft {
  return 'draft' in staged;
}

/**
 * Decomposes a change set into change records with Core-minted ids.
 *
 * Reference resolution happens here rather than at apply time so a batch stays
 * internally consistent even when the human accepts only part of it: an item
 * citing evidence that was rejected simply ends up without that citation, and
 * its provenance says so.
 */
export function buildChangeRecords(input: BuildChangeRecordsInput): BuildChangeRecordsResult {
  const { body, origin, message_id, clock } = input;
  const rationale = input.rationale ?? '';
  const notes: string[] = [];
  const now = clock();
  const knownIds = itemIds(body);

  // Normalise the incoming change set through its own schema. This fills
  // per-collection defaults and strips unknown keys *by field name*, which no
  // union of draft schemas could do unambiguously, and it means a caller that
  // hands over a plain object literal is held to the same contract as a model
  // response that arrived through the orchestrator.
  const parsedChangeSet = ChangeSetSchema.safeParse(input.changeset);
  if (!parsedChangeSet.success) {
    throw new IdenoStateError(
      'invalid_state',
      `The change set was rejected before anything was queued: ${formatZodIssuesInline(parsedChangeSet.error)}`,
    );
  }
  const changeset: ChangeSet = parsedChangeSet.data;

  // Pass 1: stage everything, minting an id per new item so that later passes
  // (and other drafts in the same batch) can reference it.
  const staged: Staged[] = [];
  const mintedIds: string[] = [];
  const tempIds = new Map<string, string>();

  for (const { key, kind } of CHANGE_SET_ORDER) {
    const value = changeset[key];
    if (value === undefined) continue;

    if (!Array.isArray(value)) {
      const scalar =
        value === null ? null : typeof value === 'string' && value.trim() ? value.trim() : null;
      if (value !== null && scalar === null) {
        notes.push(`Ignored ${kind}: expected a non-empty string.`);
        continue;
      }
      staged.push({ kind, scalar });
      continue;
    }

    for (const entry of value as Record<string, unknown>[]) {
      const mintedId = newId(ID_PREFIX[kind] ?? 'item');
      mintedIds.push(mintedId);
      if (typeof entry.temp_id === 'string' && entry.temp_id) tempIds.set(entry.temp_id, mintedId);
      staged.push({ kind, draft: { ...entry }, mintedId });
    }
  }

  const resolvable = new Set<string>([...knownIds, ...mintedIds, ...tempIds.values()]);

  // Pass 2: build records for adds and scalar revisions.
  const records: ChangeRecord[] = [];
  for (const entry of staged) {
    if (!isStagedDraft(entry)) {
      const scalarRecord = buildScalarRecord(entry, knownIds, origin, message_id, rationale, now, notes);
      if (scalarRecord) records.push(scalarRecord);
      continue;
    }

    const draft = entry.draft;
    // A model may cite evidence it is adding in the same batch by temp id.
    for (const field of ['evidence_refs', 'addresses', 'related_ids', 'alternatives_considered']) {
      const value = draft[field];
      if (!Array.isArray(value)) continue;
      draft[field] = value.map((ref) =>
        typeof ref === 'string' && tempIds.has(ref) ? tempIds.get(ref) : ref,
      );
    }
    for (const field of ['unknown_id', 'related_alternative_id']) {
      const value = draft[field];
      if (typeof value === 'string' && tempIds.has(value)) draft[field] = tempIds.get(value);
    }

    const provenance = deriveProvenance(entry.kind, draft, resolvable, notes, entry.mintedId);
    const affects = resolveAffected(draft.affects, resolvable, notes, entry.kind, entry.mintedId);
    pruneReferences(draft, resolvable, notes, entry.kind);
    delete draft.affects;
    delete draft.temp_id;

    records.push(
      makeRecord({
        kind: entry.kind,
        draft,
        affects,
        provenance,
        origin,
        message_id,
        rationale,
        now,
        resolved_item_id: entry.mintedId,
      }),
    );
  }

  // Pass 3: updates and invalidations target existing items, so they are only
  // meaningful when the id actually resolves.
  for (const update of changeset.items_updated ?? []) {
    if (!knownIds.has(update.id)) {
      notes.push(`Ignored an update to unknown item "${update.id}".`);
      continue;
    }
    records.push(
      makeRecord({
        kind: 'item_updated',
        draft: update,
        affects: resolveAffected(update.affects, resolvable, notes, 'item_updated', update.id),
        provenance: origin === 'user' ? 'user_stated' : 'model_inferred',
        origin,
        message_id,
        rationale,
        now,
        resolved_item_id: update.id,
      }),
    );
  }

  for (const invalidation of changeset.items_invalidated ?? []) {
    if (!knownIds.has(invalidation.id)) {
      notes.push(`Ignored an invalidation of unknown item "${invalidation.id}".`);
      continue;
    }
    records.push(
      makeRecord({
        kind: 'item_invalidated',
        draft: invalidation,
        affects: resolveAffected(
          invalidation.affects,
          resolvable,
          notes,
          'item_invalidated',
          invalidation.id,
        ),
        provenance: origin === 'user' ? 'user_stated' : 'model_inferred',
        origin,
        message_id,
        rationale,
        now,
        resolved_item_id: invalidation.id,
      }),
    );
  }

  return { records, notes };
}

function buildScalarRecord(
  entry: StagedScalar,
  knownIds: ReadonlySet<string>,
  origin: OriginOperation,
  message_id: string | null,
  rationale: string,
  now: string,
  notes: string[],
): ChangeRecord | null {
  if (entry.kind === 'alternative_selected') {
    const id = entry.scalar;
    if (id !== null && !knownIds.has(id)) {
      notes.push(`Ignored selection of unknown alternative "${id}".`);
      return null;
    }
    return makeRecord({
      kind: entry.kind,
      draft: id,
      affects: { item_ids: id ? [id] : [], areas: [] },
      provenance: 'user_decision',
      origin,
      message_id,
      rationale,
      now,
      resolved_item_id: id,
    });
  }

  if (entry.scalar === null) return null;
  return makeRecord({
    kind: entry.kind,
    draft: entry.scalar,
    affects: { item_ids: [], areas: [] },
    provenance: origin === 'user' ? 'user_stated' : 'model_inferred',
    origin,
    message_id,
    rationale,
    now,
  });
}

interface MakeRecordInput {
  kind: ChangeKind;
  draft: unknown;
  affects: { item_ids: string[]; areas: string[] };
  provenance: Provenance;
  origin: OriginOperation;
  message_id: string | null;
  rationale: string;
  now: string;
  resolved_item_id?: string | null;
  integrity_note?: string | null;
}

function makeRecord(input: MakeRecordInput): ChangeRecord {
  // Store the canonical draft: parsed against the schema for *this* kind, with
  // defaults filled and unknown keys stripped, so the persisted change log says
  // exactly what will be applied.
  const parsedDraft = DRAFT_SCHEMA_FOR_KIND[input.kind].safeParse(input.draft);
  if (!parsedDraft.success) {
    throw new IdenoStateError(
      'invalid_state',
      `Internal error: the draft for "${input.kind}" is invalid: ${formatZodIssuesInline(parsedDraft.error)}`,
    );
  }

  const parsed = ChangeRecordSchema.safeParse({
    id: newId('chg'),
    kind: input.kind,
    draft: parsedDraft.data,
    affects: input.affects,
    rationale: input.rationale,
    provenance: input.provenance,
    origin_operation: input.origin,
    message_id: input.message_id,
    status: 'pending',
    created_at: input.now,
    resolved_item_id: input.resolved_item_id ?? null,
    integrity_note: input.integrity_note ?? null,
  });
  if (!parsed.success) {
    // A record Core built itself should never fail. If it does, refuse to queue
    // something unvalidatable rather than storing it loosely.
    throw new Error(
      `Internal error building change record "${input.kind}": ${formatZodIssues(parsed.error).join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * Provenance is decided by Core:
 *  - evidence proposed from the model's own recall is a suggestion, never
 *    "supported by evidence";
 *  - a decision is the user's only when the user made it;
 *  - anything claiming `evidence_supported` must cite evidence that exists or is
 *    being added in the same batch, otherwise it is downgraded and the downgrade
 *    is recorded.
 */
function deriveProvenance(
  kind: ChangeKind,
  draft: Record<string, unknown>,
  resolvable: ReadonlySet<string>,
  notes: string[],
  itemId: string,
): Provenance {
  if (kind === 'evidence_added') {
    const origin = draft.origin;
    if (origin === 'user_supplied' || origin === 'research_source') {
      const locator = (draft.source as { locator?: unknown } | undefined)?.locator;
      if (typeof locator !== 'string' || locator.trim().length === 0) {
        notes.push(`Evidence ${itemId} named no source locator; stored as a model suggestion.`);
        return 'model_suggestion';
      }
      return 'evidence_supported';
    }
    // `model_recall` and anything unrecognised: the model's memory of the world
    // is a suggestion, not evidence.
    return 'model_suggestion';
  }

  if (kind === 'decision_added') {
    return draft.decided_by === 'user' ? 'user_decision' : 'model_suggestion';
  }

  // Same principle for rejections: a route the human ruled out is their decision,
  // a route Ideno discounted is a suggestion.
  if (kind === 'rejected_approach_added') {
    return draft.rejected_by === 'user' ? 'user_decision' : 'model_suggestion';
  }

  const claimed = draft.provenance as ModelClaimableProvenance | undefined;
  if (claimed !== 'evidence_supported') return claimed ?? 'model_inferred';

  const refs = Array.isArray(draft.evidence_refs) ? (draft.evidence_refs as unknown[]) : [];
  const supported = refs.some((ref) => typeof ref === 'string' && resolvable.has(ref));
  if (supported) return 'evidence_supported';

  notes.push(
    `Item ${itemId} claimed to be supported by evidence but cited none that exists; downgraded to a model suggestion.`,
  );
  return 'model_suggestion';
}

function resolveAffected(
  affects: unknown,
  resolvable: ReadonlySet<string>,
  notes: string[],
  kind: ChangeKind,
  itemId: string,
): { item_ids: string[]; areas: string[] } {
  const parsed = AffectedSchema.safeParse(affects ?? {});
  const value = parsed.success ? parsed.data : { item_ids: [], areas: [] };
  const kept = value.item_ids.filter((id) => resolvable.has(id));
  if (kept.length !== value.item_ids.length) {
    notes.push(
      `${kind} for ${itemId}: dropped ${value.item_ids.length - kept.length} unresolvable reference(s) from "affected".`,
    );
  }
  return { item_ids: kept, areas: value.areas };
}

/** Removes references to ids that exist neither in the state nor in the batch. */
function pruneReferences(
  draft: Record<string, unknown>,
  resolvable: ReadonlySet<string>,
  notes: string[],
  kind: ChangeKind,
): void {
  for (const field of ['evidence_refs', 'addresses', 'alternatives_considered', 'related_ids']) {
    const value = draft[field];
    if (!Array.isArray(value)) continue;
    const kept = value.filter((id): id is string => typeof id === 'string' && resolvable.has(id));
    if (kept.length !== value.length) {
      notes.push(`${kind}: dropped ${value.length - kept.length} unknown id(s) from "${field}".`);
    }
    draft[field] = kept;
  }

  for (const field of ['unknown_id', 'related_alternative_id']) {
    const value = draft[field];
    if (typeof value !== 'string') continue;
    if (!resolvable.has(value)) {
      notes.push(`${kind}: cleared unknown "${field}" reference "${value}".`);
      draft[field] = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Applying records
// ---------------------------------------------------------------------------

/**
 * Context `applyRecords` needs from outside the body. `asked_questions` holds the
 * normalised text of questions Ideno has already put to the human, derived from
 * the transcript, so an open question created after the fact is recorded as
 * `asked` instead of `unasked` — which is what stops it being asked twice.
 */
export interface ApplyContext {
  asked_questions: ReadonlySet<string>;
}

export const EMPTY_APPLY_CONTEXT: ApplyContext = { asked_questions: new Set() };

export function normalizeQuestion(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface RecordNote {
  record_id: string;
  note: string;
}

export interface ApplyOutcome {
  /** Records that could not be applied, each with the reason. */
  skipped: RecordNote[];
  /** Records that were written into the body. */
  applied: ChangeRecord[];
  /**
   * Applied with a caveat: a field was ignored, or an illegal field was dropped
   * while the rest of the update went through. These are surfaced, never silent.
   */
  warnings: RecordNote[];
}

/**
 * Applies records to `body` in place. Each record is trialled on a clone first,
 * so a record that throws or produces something invalid is skipped on its own
 * instead of leaving a half-written item behind.
 *
 * That costs one deep clone of the body per record. At v0.1 scale — tens of items,
 * at most sixteen records in a batch — it is microseconds, and it is what makes
 * per-record isolation unconditional rather than something that has to be reasoned
 * about per change kind. If workspaces ever grow large, the clone moves to a
 * copy-on-write per collection; the contract of this function does not change.
 */
export function applyRecords(
  body: IdeaCaseBody,
  records: ChangeRecord[],
  now: string,
  context: ApplyContext = EMPTY_APPLY_CONTEXT,
): ApplyOutcome {
  const skipped: RecordNote[] = [];
  const warnings: RecordNote[] = [];
  const applied: ChangeRecord[] = [];

  for (const record of records) {
    const candidate: IdeaCaseBody = structuredClone(body);
    const notes: string[] = [];
    let failure: string | null;
    try {
      failure = applyOne(candidate, record, now, notes, context);
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Unexpected error while applying the change.';
    }
    if (failure) {
      skipped.push({ record_id: record.id, note: failure });
      continue;
    }
    for (const note of notes) warnings.push({ record_id: record.id, note });
    Object.assign(body, candidate);
    applied.push(record);
  }

  return { skipped, applied, warnings };
}

/**
 * Validates a whole body. Called before committing any batch: if this fails, the
 * caller keeps the previous state and reports the problem.
 */
export function validateBody(body: IdeaCaseBody): { ok: true } | { ok: false; issues: string[] } {
  const parsed = IdeaCaseBodySchema.safeParse(body);
  if (parsed.success) return { ok: true };
  return { ok: false, issues: formatZodIssues(parsed.error, 6) };
}

/**
 * Validates the parts of the state that only make sense *together*: the branch
 * pointers and the version history they point into.
 *
 * `IdeaCaseBodySchema` cannot express these, because a body does not contain the
 * history. Without this check a corrupt pointer — a branch head naming a version
 * that does not exist, an active branch that is not in the list, two branches
 * sharing a name — would be written, persisted, and only discovered when a later
 * branch switch threw. Checking before the commit keeps the invariant "a stored
 * idea is internally consistent" true by construction.
 */
export function validateBranchIntegrity(
  body: IdeaCaseBody,
  history: readonly VersionRecord[],
): { ok: true } | { ok: false; issues: string[] } {
  const issues: string[] = [];

  if (body.branches.length === 0) {
    issues.push('the idea has no branches, so there is no timeline to commit to');
    return { ok: false, issues };
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const branch of body.branches) {
    if (ids.has(branch.id)) issues.push(`two branches share the id "${branch.id}"`);
    ids.add(branch.id);
    const name = branch.name.trim().toLowerCase();
    if (names.has(name)) issues.push(`two branches are both named "${branch.name}"`);
    names.add(name);
  }

  if (!body.active_branch_id || !ids.has(body.active_branch_id)) {
    issues.push(`the active branch "${body.active_branch_id ?? '(none)'}" is not in the branch list`);
  }

  const versionIds = new Set(history.map((version) => version.id));
  for (const branch of body.branches) {
    if (!versionIds.has(branch.head_version_id)) {
      issues.push(`the branch "${branch.name}" points at version "${branch.head_version_id}", which is not in the history`);
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Applies one record to `body`.
 *
 * @returns a failure reason, or `null` when the record was applied. Informational
 *          caveats are pushed onto `notes` and do not count as failures.
 */
function applyOne(
  body: IdeaCaseBody,
  record: ChangeRecord,
  now: string,
  notes: string[],
  context: ApplyContext,
): string | null {
  switch (record.kind) {
    case 'title_revised': {
      const title = String(record.draft ?? '').trim().slice(0, 280);
      if (!title) return 'Ignored an empty title revision.';
      body.title = title;
      return null;
    }
    case 'intent_revised': {
      const intent = String(record.draft ?? '').trim();
      if (!intent) return 'Ignored an empty goal revision.';
      body.current_intent = intent.slice(0, 4000);
      return null;
    }
    case 'alternative_selected':
      return applySelection(body, record);
    case 'item_updated':
      return applyUpdate(body, record, now, notes);
    case 'item_invalidated':
      return applyInvalidation(body, record, now);
    default:
      break;
  }

  const collection = ADD_KIND_TO_COLLECTION[record.kind];
  if (collection) return applyAdd(body, record, collection, now, context);
  return `Unhandled change kind "${record.kind}".`;
}

function applySelection(body: IdeaCaseBody, record: ChangeRecord): string | null {
  const target = typeof record.draft === 'string' ? record.draft : null;

  if (target === null) {
    body.selected_alternative_id = null;
    for (const alternative of body.alternatives) {
      if (alternative.status === 'selected') alternative.status = 'proposed';
    }
    return null;
  }

  const chosen = body.alternatives.find((alternative) => alternative.id === target);
  if (!chosen) return `Cannot select unknown alternative "${target}".`;

  for (const alternative of body.alternatives) {
    if (alternative.status === 'selected' && alternative.id !== target) alternative.status = 'proposed';
  }
  chosen.status = 'selected';
  body.selected_alternative_id = target;
  return null;
}

function applyAdd(
  body: IdeaCaseBody,
  record: ChangeRecord,
  collection: CollectionName,
  now: string,
  context: ApplyContext,
): string | null {
  const items = body[collection] as unknown[];
  const limit = COLLECTION_LIMITS[collection];
  if (items.length >= limit) {
    return `${collection} is at its limit of ${limit} items; change not applied.`;
  }
  if (
    record.resolved_item_id &&
    items.some((item) => (item as { id: string }).id === record.resolved_item_id)
  ) {
    return `An item with id ${record.resolved_item_id} already exists; change not applied.`;
  }

  const parsed = parseItem(collection, buildItemFromDraft(collection, record, now, context));
  if (!parsed.ok) return `Rejected ${record.kind}: ${parsed.issues.join('; ')}`;

  items.push(parsed.item);
  return null;
}

function buildItemFromDraft(
  collection: CollectionName,
  record: ChangeRecord,
  now: string,
  context: ApplyContext,
): Record<string, unknown> {
  const draft = record.draft as Record<string, unknown>;
  const base: Record<string, unknown> = {
    ...draft,
    id: record.resolved_item_id ?? newId('item'),
    origin_operation: record.origin_operation,
    source_message_id: record.message_id,
    created_at: now,
    updated_at: null,
    provenance: record.provenance,
  };

  switch (collection) {
    case 'evidence':
      // Evidence keeps `timestamp` and has no `updated_at`.
      return { ...base, timestamp: now, status: 'accepted' };
    case 'research_items':
      return { ...base, status: 'open', evidence_refs: [] };
    case 'open_questions': {
      // If Ideno already put this question to the human (recorded on a transcript
      // entry), the item starts out as asked rather than waiting to be asked.
      const asked = context.asked_questions.has(normalizeQuestion(String(base.question ?? '')));
      return asked
        ? { ...base, status: 'asked', asked_at: now }
        : { ...base, status: 'unasked', asked_at: null };
    }
    default:
      return base;
  }
}

function applyUpdate(
  body: IdeaCaseBody,
  record: ChangeRecord,
  now: string,
  notes: string[],
): string | null {
  const update = record.draft as ItemUpdate;
  const located = locate(body, update.id);
  if (!located) return `Cannot update unknown item "${update.id}".`;

  const { collection, index } = located;
  const items = body[collection] as unknown[];
  const current = items[index] as Record<string, unknown>;
  const patched: Record<string, unknown> = { ...current, updated_at: now };
  const skipped: string[] = [];

  if (typeof update.text === 'string' && update.text.trim()) {
    patched[PRIMARY_TEXT_FIELD[collection]] = update.text.trim();
  }
  if (update.notes !== undefined) patched.notes = update.notes;
  if (typeof update.status === 'string') patched.status = update.status;

  // These fields exist on some collections only. Applying them elsewhere would
  // be a schema violation, so they are ignored (and reported) instead.
  if (typeof update.confidence === 'number') {
    if (collection === 'assumptions') patched.confidence = update.confidence;
    else skipped.push('confidence');
  }
  if (typeof update.impact === 'string') {
    if (collection === 'unknowns' || collection === 'open_questions') patched.impact = update.impact;
    else skipped.push('impact');
  }
  if (typeof update.priority === 'string') {
    if (collection === 'research_items') patched.priority = update.priority;
    else skipped.push('priority');
  }
  if (update.resolution !== undefined) {
    if (collection === 'unknowns') patched.resolution = update.resolution;
    else skipped.push('resolution');
  }

  const parsed = parseItem(collection, patched);
  if (parsed.ok) {
    items[index] = parsed.item;
    if (skipped.length > 0) {
      notes.push(
        `Update to ${update.id} ignored field(s) that ${collection} does not carry: ${skipped.join(', ')}.`,
      );
    }
    return null;
  }

  // One illegal enum from a model must not discard a legitimate text correction.
  const minimal: Record<string, unknown> = { ...current, updated_at: now };
  let salvaged = false;
  if (typeof update.text === 'string' && update.text.trim()) {
    minimal[PRIMARY_TEXT_FIELD[collection]] = update.text.trim();
    salvaged = true;
  }
  if (update.notes !== undefined) {
    minimal.notes = update.notes;
    salvaged = true;
  }
  const minimalParsed = parseItem(collection, minimal);
  if (!salvaged || !minimalParsed.ok) {
    return `Rejected update to ${update.id}: ${parsed.issues.join('; ')}`;
  }
  items[index] = minimalParsed.item;
  notes.push(
    `Update to ${update.id} was applied without its invalid field(s): ${parsed.issues
      .map((issue) => issue.split(':')[0])
      .join(', ')}.`,
  );
  return null;
}

function applyInvalidation(body: IdeaCaseBody, record: ChangeRecord, now: string): string | null {
  const invalidation = record.draft as ItemInvalidation;
  const located = locate(body, invalidation.id);
  if (!located) return `Cannot invalidate unknown item "${invalidation.id}".`;

  const { collection, index } = located;
  const items = body[collection] as unknown[];
  const current = items[index] as Record<string, unknown>;

  const requested = invalidation.new_status ?? TERMINAL_STATUS[collection];
  const status = AnyItemStatusSchema.safeParse(requested).success
    ? (requested as AnyItemStatus)
    : (TERMINAL_STATUS[collection] as AnyItemStatus);

  const note = `[invalidated: ${invalidation.reason}]`;
  const existingNotes = typeof current.notes === 'string' && current.notes ? `${current.notes} ${note}` : note;

  const parsed = parseItem(collection, {
    ...current,
    status,
    notes: existingNotes.slice(0, 1000),
    updated_at: now,
  });
  if (!parsed.ok) return `Rejected invalidation of ${invalidation.id}: ${parsed.issues.join('; ')}`;

  items[index] = parsed.item;
  return null;
}

function locate(body: IdeaCaseBody, id: string): { collection: CollectionName; index: number } | null {
  for (const collection of COLLECTIONS) {
    const items = body[collection] as { id: string }[];
    const index = items.findIndex((item) => item.id === id);
    if (index !== -1) return { collection, index };
  }
  return null;
}
