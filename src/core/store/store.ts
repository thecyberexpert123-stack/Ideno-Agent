import { IdenoError } from '../errors.js';
import { IdeaCaseSchema, type IdeaCase } from '../schemas.js';

export interface CaseSummary {
  readonly id: string;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: number;
  readonly phase: IdeaCase['current_state']['phase'];
  readonly pending_changesets: number;
}

/**
 * Persistence boundary for Idea Cases.
 *
 * `update` takes a mutator rather than a finished case on purpose: the store
 * owns the read-modify-write critical section, so no caller can accidentally
 * clobber a concurrent write.
 */
export interface CaseStore {
  list(): Promise<CaseSummary[]>;
  get(id: string): Promise<IdeaCase | null>;
  create(ideaCase: IdeaCase): Promise<IdeaCase>;
  /**
   * Atomically reads, transforms and writes a case.
   * The mutator receives a private copy and must return the case to persist.
   */
  update(id: string, mutator: (ideaCase: IdeaCase) => Promise<IdeaCase> | IdeaCase): Promise<IdeaCase>;
  delete(id: string): Promise<boolean>;
}

/**
 * Validates a case before it is persisted.
 *
 * Stores call this instead of `IdeaCaseSchema.parse` so a schema violation
 * surfaces as a typed `validation_failed` rather than a raw `ZodError`: the
 * HTTP layer must be able to classify it, and a bare ZodError would be
 * reported to the user as an unexplained 500.
 */
export function validateCase(ideaCase: IdeaCase): IdeaCase {
  const parsed = IdeaCaseSchema.safeParse(ideaCase);
  if (!parsed.success) {
    throw new IdenoError(
      'validation_failed',
      `The idea case "${ideaCase?.id ?? 'unknown'}" does not satisfy the state schema, so it was not written.`,
      { details: parsed.error.issues.slice(0, 10) },
    );
  }
  return parsed.data;
}
