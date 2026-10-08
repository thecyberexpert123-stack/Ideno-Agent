import { Router } from 'express';
import { z } from 'zod';
import { IdenoError } from '../../core/errors.js';
import { summarizeState } from '../../core/idea_state.js';
import { changesBetween, describeVersion, getVersion } from '../../core/versioning.js';
import type { Services } from '../container.js';
import { parseBody } from '../http.js';

const CreateCaseSchema = z.object({
  idea: z.string().trim().min(1).max(20_000),
  title: z.string().trim().min(1).max(300).optional(),
});

const TurnSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  providerId: z.string().trim().min(1).max(64).optional(),
  /** Apply the resulting proposal immediately instead of queuing it. */
  autoAccept: z.boolean().optional(),
});

const DecisionSchema = z
  .object({
    acceptAll: z.boolean().optional(),
    acceptedEntryIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  })
  .refine((value) => value.acceptAll !== undefined || value.acceptedEntryIds !== undefined, {
    message: 'Provide acceptAll or acceptedEntryIds',
  });

export function caseRoutes(services: Services): Router {
  const router = Router();
  const { stateManager, orchestrator } = services;

  router.get('/cases', async (_request, response) => {
    response.json({ cases: await stateManager.listCases() });
  });

  router.post('/cases', async (request, response) => {
    const body = parseBody(CreateCaseSchema, request.body);
    const ideaCase = await stateManager.createCase(body.idea, body.title);
    response.status(201).json({ case: ideaCase, summary: summarizeState(ideaCase) });
  });

  router.get('/cases/:caseId', async (request, response) => {
    const ideaCase = await stateManager.getCase(request.params.caseId);
    response.json({ case: ideaCase, summary: summarizeState(ideaCase) });
  });

  router.delete('/cases/:caseId', async (request, response) => {
    const deleted = await stateManager.deleteCase(request.params.caseId);
    if (!deleted) throw new IdenoError('not_found', 'That case does not exist.');
    response.status(204).end();
  });

  router.post('/cases/:caseId/turns', async (request, response) => {
    const body = parseBody(TurnSchema, request.body);
    // Confirms the case exists before spending a model call on it.
    await stateManager.getCase(request.params.caseId);

    const outcome = await orchestrator.runTurn({
      caseId: request.params.caseId,
      message: body.message,
      ...(body.providerId === undefined ? {} : { providerId: body.providerId }),
      ...(body.autoAccept === undefined ? {} : { autoAccept: body.autoAccept }),
    });

    response.json({
      case: outcome.ideaCase,
      summary: summarizeState(outcome.ideaCase),
      reply: outcome.reply,
      changeset: outcome.changeset,
      plan: outcome.plan,
      degraded: outcome.degraded,
      failures: outcome.failures,
      question: outcome.question,
    });
  });

  router.post('/cases/:caseId/changesets/:changesetId/decision', async (request, response) => {
    const body = parseBody(DecisionSchema, request.body);
    const result = await stateManager.decideChangeSet(
      request.params.caseId,
      request.params.changesetId,
      {
        ...(body.acceptAll === undefined ? {} : { acceptAll: body.acceptAll }),
        ...(body.acceptedEntryIds === undefined ? {} : { acceptedEntryIds: body.acceptedEntryIds }),
      },
    );
    response.json({
      case: result.ideaCase,
      summary: summarizeState(result.ideaCase),
      changeset: result.changeset,
      version: result.version,
    });
  });

  router.get('/cases/:caseId/versions', async (request, response) => {
    const ideaCase = await stateManager.getCase(request.params.caseId);
    response.json({
      versions: ideaCase.version_history.map((version) => ({
        ...version,
        changes: describeVersion(ideaCase, version),
      })),
    });
  });

  router.get('/cases/:caseId/versions/:index', async (request, response) => {
    const ideaCase = await stateManager.getCase(request.params.caseId);
    const index = Number.parseInt(request.params.index ?? '', 10);
    if (!Number.isInteger(index)) {
      throw new IdenoError('bad_request', 'The version index must be an integer.');
    }
    const version = getVersion(ideaCase, index);
    if (!version) throw new IdenoError('not_found', `Version v${index} does not exist.`);

    const compareTo = request.query.compareTo;
    const from = typeof compareTo === 'string' ? Number.parseInt(compareTo, 10) : index - 1;

    response.json({
      version,
      changes: describeVersion(ideaCase, version),
      range: Number.isInteger(from) ? changesBetween(ideaCase, from, index) : [],
    });
  });

  return router;
}
