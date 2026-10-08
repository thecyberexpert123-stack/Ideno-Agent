import { KeyedMutex } from '../async_lock.js';
import { IdenoError } from '../errors.js';
import { summarizeState } from '../idea_state.js';
import type { IdeaCase } from '../schemas.js';
import { validateCase, type CaseStore, type CaseSummary } from './store.js';

/**
 * In-memory case store.
 *
 * Used by the test suite and by `IDENO_STORE=memory` for ephemeral runs. It
 * enforces exactly the same validation and locking rules as the file store, so
 * a behaviour that passes here is not relying on persistence specifics.
 */
export class MemoryCaseStore implements CaseStore {
  readonly #cases = new Map<string, IdeaCase>();
  readonly #mutex = new KeyedMutex();

  async list(): Promise<CaseSummary[]> {
    return [...this.#cases.values()]
      .map((ideaCase) => {
        const summary = summarizeState(ideaCase);
        return {
          id: ideaCase.id,
          title: ideaCase.title,
          created_at: ideaCase.created_at,
          updated_at: ideaCase.updated_at,
          version: summary.version,
          phase: ideaCase.current_state.phase,
          pending_changesets: summary.pendingChangeSets,
        };
      })
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async get(id: string): Promise<IdeaCase | null> {
    const found = this.#cases.get(id);
    return found ? structuredClone(found) : null;
  }

  async create(ideaCase: IdeaCase): Promise<IdeaCase> {
    const validated = validateCase(ideaCase);
    return this.#mutex.run(validated.id, async () => {
      if (this.#cases.has(validated.id)) {
        throw new IdenoError('conflict', `Case ${validated.id} already exists`);
      }
      this.#cases.set(validated.id, structuredClone(validated));
      return validated;
    });
  }

  async update(
    id: string,
    mutator: (ideaCase: IdeaCase) => Promise<IdeaCase> | IdeaCase,
  ): Promise<IdeaCase> {
    return this.#mutex.run(id, async () => {
      const current = this.#cases.get(id);
      if (!current) throw new IdenoError('not_found', `Case ${id} was not found`);
      const next = await mutator(structuredClone(current));
      if (next.id !== id) {
        throw new IdenoError('internal_error', 'A case mutator must not change the case id');
      }
      const validated = validateCase(next);
      this.#cases.set(id, structuredClone(validated));
      return validated;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.#mutex.run(id, async () => this.#cases.delete(id));
  }
}
