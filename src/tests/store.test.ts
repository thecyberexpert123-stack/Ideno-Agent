import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdenoError } from '../core/errors.js';
import { createIdeaCase } from '../core/idea_state.js';
import { newCaseId } from '../core/ids.js';
import type { IdeaCase } from '../core/schemas.js';
import { FileCaseStore } from '../core/store/file_store.js';
import { MemoryCaseStore } from '../core/store/memory_store.js';
import type { CaseStore } from '../core/store/store.js';

/**
 * Persistence.
 *
 * Both stores are held to the same contract, because the only difference the
 * rest of the system is allowed to see is whether data survives a restart.
 * The read-modify-write path gets specific attention: a lost update there
 * silently destroys a version of the user's idea.
 */

function makeCase(idea = 'A quiet, low-power weather station for a balcony.'): IdeaCase {
  return createIdeaCase({ id: newCaseId(), originalIdea: idea });
}

interface StoreFixture {
  store: CaseStore;
  cleanup: () => Promise<void>;
}

describe.each([
  [
    'MemoryCaseStore',
    async (): Promise<StoreFixture> => ({
      store: new MemoryCaseStore(),
      cleanup: async () => undefined,
    }),
  ],
  [
    'FileCaseStore',
    async (): Promise<StoreFixture> => {
      const directory = await mkdtemp(join(tmpdir(), 'ideno-store-'));
      return {
        store: new FileCaseStore(directory),
        cleanup: async () => {
          await rm(directory, { recursive: true, force: true });
        },
      };
    },
  ],
] as const)('%s', (_name, factory) => {
  let store: CaseStore;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const created = await factory();
    store = created.store;
    cleanup = created.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('round-trips a case', async () => {
    const ideaCase = makeCase();
    await store.create(ideaCase);

    const loaded = await store.get(ideaCase.id);
    expect(loaded?.id).toBe(ideaCase.id);
    expect(loaded?.original_idea).toBe(ideaCase.original_idea);
    expect(loaded?.version_history).toHaveLength(1);
  });

  it('returns null for a case that does not exist', async () => {
    await expect(store.get(newCaseId())).resolves.toBeNull();
  });

  it('refuses to create the same case twice', async () => {
    const ideaCase = makeCase();
    await store.create(ideaCase);
    await expect(store.create(ideaCase)).rejects.toBeInstanceOf(IdenoError);
  });

  it('lists summaries without loading full cases into the caller', async () => {
    await store.create(makeCase('A balcony greenhouse.'));
    await store.create(makeCase('A rooftop rain collector.'));

    const summaries = await store.list();
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary.version).toBe(0);
      expect(summary.phase).toBe('capturing');
      expect(summary.pending_changesets).toBe(0);
      expect(Object.keys(summary)).not.toContain('requirements');
    }
  });

  it('deletes a case and reports whether anything was removed', async () => {
    const ideaCase = makeCase();
    await store.create(ideaCase);

    await expect(store.delete(ideaCase.id)).resolves.toBe(true);
    await expect(store.get(ideaCase.id)).resolves.toBeNull();
    await expect(store.delete(ideaCase.id)).resolves.toBe(false);
  });

  it('raises a typed error when updating a missing case', async () => {
    await expect(store.update(newCaseId(), (value) => value)).rejects.toBeInstanceOf(IdenoError);
  });

  it('serialises concurrent updates so no write is lost', async () => {
    const ideaCase = makeCase();
    await store.create(ideaCase);

    // Each update reads, yields to the event loop, then writes. Without
    // locking, all ten would read the same current_intent and nine updates
    // would vanish.
    await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        store.update(ideaCase.id, async (current) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return { ...current, current_intent: `${current.current_intent}${index},` };
        }),
      ),
    );

    const loaded = await store.get(ideaCase.id);
    const written = (loaded?.current_intent ?? '').split(',').filter(Boolean);
    expect(written).toHaveLength(10);
    expect(new Set(written).size).toBe(10);
  });

  it('does not persist a mutation when the mutator throws', async () => {
    const ideaCase = makeCase();
    await store.create(ideaCase);

    await expect(
      store.update(ideaCase.id, () => {
        throw new Error('reasoning failed mid-write');
      }),
    ).rejects.toThrow('reasoning failed mid-write');

    const loaded = await store.get(ideaCase.id);
    expect(loaded?.current_intent).toBe('');
  });

  it('rejects state that does not satisfy the schema', async () => {
    const ideaCase = makeCase();
    await store.create(ideaCase);

    await expect(
      store.update(ideaCase.id, (current) => ({ ...current, title: '' }) as IdeaCase),
    ).rejects.toBeInstanceOf(IdenoError);

    const loaded = await store.get(ideaCase.id);
    expect(loaded?.title.length).toBeGreaterThan(0);
  });
});

describe('FileCaseStore specifics', () => {
  let directory: string;
  let store: FileCaseStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ideno-file-'));
    store = new FileCaseStore(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('survives a restart', async () => {
    const ideaCase = makeCase('A solar dryer for herbs.');
    await store.create(ideaCase);

    const reopened = new FileCaseStore(directory);
    const loaded = await reopened.get(ideaCase.id);
    expect(loaded?.original_idea).toBe('A solar dryer for herbs.');
  });

  it('writes human-readable JSON', async () => {
    const ideaCase = makeCase();
    await store.create(ideaCase);

    const contents = await readFile(join(directory, `${ideaCase.id}.json`), 'utf8');
    expect(contents).toContain('\n  ');
    expect(JSON.parse(contents).id).toBe(ideaCase.id);
  });

  it('reports a corrupt case file instead of returning half a case', async () => {
    const id = newCaseId();
    await writeFile(join(directory, `${id}.json`), '{"id": "truncated"', 'utf8');
    await expect(store.get(id)).rejects.toBeInstanceOf(IdenoError);
  });

  it('skips unreadable files when listing rather than failing the whole list', async () => {
    const good = makeCase();
    await store.create(good);
    await writeFile(join(directory, `${newCaseId()}.json`), 'not json at all', 'utf8');

    const summaries = await store.list();
    expect(summaries.map((summary) => summary.id)).toEqual([good.id]);
  });

  it('refuses ids that would escape the data directory', async () => {
    await expect(store.get('../../../etc/passwd')).rejects.toBeInstanceOf(IdenoError);
    await expect(store.delete('..')).rejects.toBeInstanceOf(IdenoError);
  });
});
