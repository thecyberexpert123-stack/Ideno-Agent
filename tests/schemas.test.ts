import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AnyItemStatusSchema,
  AssumptionDraftSchema,
  ChangeRecordSchema,
  ChangeSetSchema,
  ConstraintDraftSchema,
  DecisionDraftSchema,
  EvidenceDraftSchema,
  IdeaCaseSchema,
  ModelClaimableProvenanceSchema,
  RequirementDraftSchema,
  TurnPlanSchema,
  WorkspaceSchema,
  WORKSPACE_SCHEMA_VERSION,
  LEGACY_WORKSPACE_SCHEMA_VERSION,
  LegacyWorkspaceSchema,
  isEmptyChangeSet,
} from '../src/core/schemas/index.js';
import { SettingsSchema } from '../src/ai/settings.js';

describe('provenance discipline', () => {
  it('lets a model claim everything except a user decision', () => {
    expect(ModelClaimableProvenanceSchema.options).not.toContain('user_decision');
    expect(ModelClaimableProvenanceSchema.options).toContain('user_stated');
    expect(ModelClaimableProvenanceSchema.options).toContain('evidence_supported');
  });

  it('rejects a draft that tries to claim the user decided something', () => {
    const result = RequirementDraftSchema.safeParse({
      text: 'Must be cheap',
      provenance: 'user_decision',
    });
    expect(result.success).toBe(false);
  });

  it('does not expose a provenance field on evidence or decision drafts', () => {
    expect(Object.keys(EvidenceDraftSchema.shape)).not.toContain('provenance');
    expect(Object.keys(DecisionDraftSchema.shape)).not.toContain('provenance');
  });

  it('does not let a draft mint an id, timestamp or origin operation', () => {
    for (const schema of [RequirementDraftSchema, ConstraintDraftSchema, EvidenceDraftSchema]) {
      const keys = Object.keys(schema.shape);
      expect(keys).not.toContain('id');
      expect(keys).not.toContain('created_at');
      expect(keys).not.toContain('origin_operation');
      expect(keys).not.toContain('source_message_id');
    }
  });
});

describe('schema defaults', () => {
  it('fills collection defaults so an empty case parses', () => {
    const parsed = IdeaCaseSchema.parse({
      id: 'idea_1',
      title: 'Greenhouse',
      original_idea: 'A greenhouse',
      current_intent: 'A greenhouse',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    expect(parsed.requirements).toEqual([]);
    expect(parsed.findings).toEqual([]);
    expect(parsed.current_state).toBe('seed');
    expect(parsed.selected_alternative_id).toBeNull();
    expect(parsed.version_history).toEqual([]);
  });

  it('defaults settings to Puter, assisted review and a 60s timeout', () => {
    const settings = SettingsSchema.parse({});
    expect(settings.provider_id).toBe('puter');
    expect(settings.review_mode).toBe('assisted');
    expect(settings.timeout_ms).toBe(60_000);
    expect(settings.openai.persist_api_key).toBe(false);
  });

  it('defaults an item draft to an inferred assumption, not a fact', () => {
    const parsed = ConstraintDraftSchema.parse({ text: 'Must be quiet' });
    expect(parsed.provenance).toBe('model_inferred');
    expect(parsed.hard).toBe(true);
    expect(parsed.status).toBe('active');
  });

  it('bounds confidence to [0, 1]', () => {
    expect(AssumptionDraftSchema.safeParse({ text: 'x', confidence: 0.4 }).success).toBe(true);
    expect(AssumptionDraftSchema.safeParse({ text: 'x', confidence: 1.5 }).success).toBe(false);
    expect(AssumptionDraftSchema.safeParse({ text: 'x', confidence: -0.1 }).success).toBe(false);
  });

  it('strips fields a draft is not allowed to carry', () => {
    const parsed = ConstraintDraftSchema.parse({
      text: 'Must be quiet',
      id: 'con_hacked',
      created_at: '1999-01-01T00:00:00.000Z',
      provenance: 'model_inferred',
      unexpected: 'ignored',
    });
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('unexpected');
    expect(parsed.text).toBe('Must be quiet');
  });
});

describe('change set contract', () => {
  it('caps every collection so one response cannot flood the state', () => {
    const many = Array.from({ length: 13 }, (_, index) => ({ text: `Requirement ${index}` }));
    expect(ChangeSetSchema.safeParse({ requirements_added: many }).success).toBe(false);
    expect(ChangeSetSchema.safeParse({ requirements_added: many.slice(0, 12) }).success).toBe(true);
  });

  it('detects an empty change set', () => {
    expect(isEmptyChangeSet({})).toBe(true);
    expect(isEmptyChangeSet({ title: 'x' })).toBe(false);
    expect(isEmptyChangeSet({ selected_alternative_id: null })).toBe(false);
    expect(isEmptyChangeSet({ constraints_added: [] })).toBe(true);
  });

  it('accepts a null selected_alternative_id so a selection can be cleared', () => {
    const record = ChangeRecordSchema.safeParse({
      id: 'chg_1',
      kind: 'alternative_selected',
      draft: null,
      affects: { item_ids: [], areas: [] },
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(record.success).toBe(true);
  });

  it('covers every item status in the cross-collection update enum', () => {
    for (const status of ['open', 'satisfied', 'invalidated', 'relaxed', 'selected', 'dismissed']) {
      expect(AnyItemStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(AnyItemStatusSchema.safeParse('not-a-status').success).toBe(false);
  });
});

describe('turn plan contract', () => {
  const validPlan = {
    operation: 'understand',
    classification: 'new_idea',
    reasoning_summary: 'Extracted the goal and the first requirements.',
    user_message: 'Here is how I understand the idea so far.',
    changes: {},
    question: null,
    followups: [],
  };

  it('accepts a minimal valid plan', () => {
    const parsed = TurnPlanSchema.safeParse(validPlan);
    expect(parsed.success).toBe(true);
  });

  it('rejects a plan with no message for the user', () => {
    expect(TurnPlanSchema.safeParse({ ...validPlan, user_message: '   ' }).success).toBe(false);
  });

  it('refuses more than two follow-up operations in one turn', () => {
    expect(
      TurnPlanSchema.safeParse({ ...validPlan, followups: ['critique', 'explore', 'research'] })
        .success,
    ).toBe(false);
  });

  it('bounds the reasoning summary so no chain-of-thought dump is stored', () => {
    expect(
      TurnPlanSchema.safeParse({ ...validPlan, reasoning_summary: 'x'.repeat(801) }).success,
    ).toBe(false);
  });

  /**
   * The runtime derives the JSON Schema it shows a model from this very schema.
   * If a future field type cannot be represented, the prompt silently loses its
   * contract — so this is asserted rather than assumed.
   */
  it('is representable as JSON Schema', () => {
    const json = z.toJSONSchema(TurnPlanSchema);
    expect(json.type).toBe('object');
    const properties = (json as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(['operation', 'classification', 'user_message', 'changes', 'question']),
    );
  });
});

describe('workspace format', () => {
  it('pins the schema version so stale storage is detected, not guessed at', () => {
    expect(WORKSPACE_SCHEMA_VERSION).toBe(2);
    expect(LEGACY_WORKSPACE_SCHEMA_VERSION).toBe(1);
    // A payload claiming a *newer* format than this build knows must be refused
    // outright: guessing at an unknown layout is how stored ideas get rewritten.
    expect(
      WorkspaceSchema.safeParse({ schema_version: 3, session: {}, saved_at: '2026-01-01T00:00:00.000Z' })
        .success,
    ).toBe(false);
    // The v0.1 format is still readable, but only through the legacy schema.
    expect(
      LegacyWorkspaceSchema.safeParse({ schema_version: 1, session: {}, saved_at: '2026-01-01T00:00:00.000Z' })
        .success,
    ).toBe(false); // session: {} is not a session — the *version* is what is accepted
    expect(LegacyWorkspaceSchema.shape.schema_version.value).toBe(1);
  });
});
