import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../core/async_lock.js';
import { ID_PREFIXES, isCaseId, newCaseId, shortId, uniqueShortId } from '../core/ids.js';
import {
  activeItems,
  createIdeaCase,
  deriveProvisionalTitle,
  itemExists,
  latestVersion,
  locateItem,
  nextVersionIndex,
  summarizeState,
} from '../core/idea_state.js';
import { applyOperations } from '../core/patch.js';
import {
  IdeaCaseSchema,
  SCHEMA_VERSION,
  StateOperationSchema,
  type StateOperation,
} from '../core/schemas.js';
import { changesBetween, commitVersion, describeOperation, getVersion } from '../core/versioning.js';

/**
 * Foundations: identifiers, schema contracts, state helpers, versioning and
 * the concurrency primitive the store depends on.
 */

function baseCase() {
  return createIdeaCase({
    id: newCaseId(),
    originalIdea: 'A rainwater-fed vertical farm for a flat roof.',
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
}

const APPLY = { origin: 'user', versionIndex: 1, now: new Date('2026-01-01T00:00:00.000Z') } as const;

function commit(draft: ReturnType<typeof baseCase>, input: {
  label: string;
  summary?: string;
  changesetId?: string | null;
  operations: StateOperation[];
}) {
  return commitVersion(draft, {
    label: input.label,
    summary: input.summary ?? '',
    changesetId: input.changesetId ?? null,
    operations: input.operations,
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
}

function addOp(collection: 'requirements' | 'constraints', text: string): StateOperation {
  return {
    op: 'add',
    collection,
    item: { text, epistemic_status: 'assumed' },
  } as StateOperation;
}

describe('identifiers', () => {
  it('mints prefixed, lower-case hex ids', () => {
    const id = shortId(ID_PREFIXES.requirement);
    expect(id).toMatch(/^req-[0-9a-f]{8}$/u);
  });

  it('never returns an id that is already taken', () => {
    const taken = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const id = uniqueShortId(ID_PREFIXES.assumption, taken);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
    expect(taken.size).toBe(200);
  });

  it('recognises its own case ids and rejects foreign ones', () => {
    const id = newCaseId();
    expect(isCaseId(id)).toBe(true);
    expect(isCaseId('../../etc/passwd')).toBe(false);
    expect(isCaseId('req-00000000')).toBe(false);
  });
});

describe('createIdeaCase', () => {
  it('preserves the original wording verbatim and derives a title', () => {
    const idea = '  I want to build a small autonomous greenhouse.  ';
    const ideaCase = createIdeaCase({ id: newCaseId(), originalIdea: idea });

    expect(ideaCase.original_idea).toBe(idea.trim());
    expect(ideaCase.title.length).toBeGreaterThan(0);
    expect(ideaCase.schema_version).toBe(SCHEMA_VERSION);
    expect(ideaCase.version_history).toHaveLength(1);
    expect(latestVersion(ideaCase).index).toBe(0);
    expect(nextVersionIndex(ideaCase)).toBe(1);
  });

  it('validates against the canonical schema', () => {
    expect(() => IdeaCaseSchema.parse(baseCase())).not.toThrow();
  });

  it('shortens a long opening sentence into a usable title', () => {
    const title = deriveProvisionalTitle(
      'I would like to design a modular, solar powered irrigation controller that can also talk to a weather service and log everything locally for later analysis.',
    );
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.length).toBeGreaterThan(0);
  });
});

describe('state helpers', () => {
  it('locates items across collections and ignores unknown ids', () => {
    const { ideaCase } = applyOperations(
      baseCase(),
      [{ id: 'e1', operation: addOp('requirements', 'Must water plants automatically.') }],
      APPLY,
    );
    const item = ideaCase.requirements[0];
    expect(item).toBeDefined();

    const located = locateItem(ideaCase, item!.id);
    expect(located?.collection).toBe('requirements');
    expect(itemExists(ideaCase, item!.id)).toBe(true);
    expect(locateItem(ideaCase, 'req-deadbeef')).toBeNull();
    expect(itemExists(ideaCase, 'req-deadbeef')).toBe(false);
  });

  it('counts only active items in the summary', () => {
    const { ideaCase } = applyOperations(
      baseCase(),
      [
        { id: 'e1', operation: addOp('constraints', 'Must fit a 2 m by 1 m roof section.') },
        { id: 'e2', operation: addOp('constraints', 'Total budget under 400 EUR.') },
      ],
      APPLY,
    );
    const target = ideaCase.constraints[0]!.id;

    const { ideaCase: after } = applyOperations(
      ideaCase,
      [
        {
          id: 'e3',
          operation: { op: 'invalidate', target_id: target, reason: 'The roof section grew.' },
        },
      ],
      { ...APPLY, versionIndex: 2 },
    );

    expect(activeItems(after, 'constraints')).toHaveLength(1);
    const summary = summarizeState(after);
    expect(summary.constraints).toBe(1);
    expect(summary.invalidated).toBe(1);
  });
});

describe('operation schema', () => {
  it('accepts a well-formed add', () => {
    expect(StateOperationSchema.safeParse(addOp('requirements', 'Runs unattended for a week.')).success).toBe(
      true,
    );
  });

  it('rejects an unknown collection', () => {
    const result = StateOperationSchema.safeParse({
      op: 'add',
      collection: 'wishes',
      item: { text: 'x', epistemic_status: 'assumed' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown epistemic status', () => {
    const result = StateOperationSchema.safeParse({
      op: 'add',
      collection: 'requirements',
      item: { text: 'x', epistemic_status: 'probably_true' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty item text', () => {
    const result = StateOperationSchema.safeParse({
      op: 'add',
      collection: 'requirements',
      item: { text: '   ', epistemic_status: 'assumed' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a confidence outside [0,1]', () => {
    const result = StateOperationSchema.safeParse({
      op: 'add',
      collection: 'requirements',
      item: { text: 'x', epistemic_status: 'assumed', confidence: 1.4 },
    });
    expect(result.success).toBe(false);
  });
});

describe('versioning', () => {
  it('appends a linear version and links it to its parent', () => {
    const draft = structuredClone(baseCase());
    const parent = latestVersion(draft);

    const version = commit(draft, {
      label: 'v1 — 2 constraints',
      summary: 'Added the balcony constraints.',
      changesetId: 'cs-00000001',
      operations: [addOp('constraints', 'Must fit on a balcony.')],
    });

    expect(version.index).toBe(1);
    expect(version.parent_id).toBe(parent.id);
    expect(draft.version_history).toHaveLength(2);
    expect(getVersion(draft, 1)?.id).toBe(version.id);
    expect(getVersion(draft, 7)).toBeNull();
  });

  it('describes every operation kind in plain language', () => {
    const descriptions = [
      describeOperation(addOp('requirements', 'Logs sensor data locally.')),
      describeOperation({
        op: 'invalidate',
        target_id: 'asm-00000000',
        reason: 'Cloud connectivity was ruled out.',
      }),
      describeOperation({
        op: 'relate',
        from: 'req-00000000',
        to: 'con-00000000',
        type: 'depends_on',
      }),
    ];
    for (const description of descriptions) {
      expect(description.length).toBeGreaterThan(0);
      expect(description).not.toContain('undefined');
    }
  });

  it('collects changes across a version range', () => {
    const draft = structuredClone(baseCase());
    commit(draft, { label: 'v1', operations: [addOp('requirements', 'Waters on a schedule.')] });
    commit(draft, { label: 'v2', operations: [addOp('constraints', 'Fits on a balcony.')] });

    expect(changesBetween(draft, 0, 2)).toHaveLength(2);
    expect(changesBetween(draft, 1, 2)).toHaveLength(1);
    // An inverted or out-of-range window yields nothing rather than throwing.
    expect(changesBetween(draft, 5, 2)).toHaveLength(0);
  });
});

describe('KeyedMutex', () => {
  it('serialises tasks sharing a key', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    let concurrent = 0;
    let peak = 0;

    const task = (name: string) =>
      mutex.run('case-a', async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(name);
        concurrent -= 1;
      });

    await Promise.all([task('first'), task('second'), task('third')]);

    expect(peak).toBe(1);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    let concurrent = 0;
    let peak = 0;

    const task = (key: string) =>
      mutex.run(key, async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
      });

    await Promise.all([task('a'), task('b'), task('c')]);
    expect(peak).toBeGreaterThan(1);
  });

  it('does not let a failed task poison the queue', async () => {
    const mutex = new KeyedMutex();
    const failure = mutex.run('case-a', async () => {
      throw new Error('boom');
    });

    await expect(failure).rejects.toThrow('boom');
    await expect(mutex.run('case-a', async () => 'ok')).resolves.toBe('ok');
  });

  it('releases the key once every queued task settles', async () => {
    const mutex = new KeyedMutex();
    await Promise.all([
      mutex.run('a', async () => undefined),
      mutex.run('a', async () => undefined),
    ]);
    expect(mutex.activeKeys).toBe(0);
  });
});
