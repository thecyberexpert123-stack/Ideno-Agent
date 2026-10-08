import { Router } from 'express';
import { z } from 'zod';
import { IdenoError } from '../../core/errors.js';
import { summarizeState } from '../../core/idea_state.js';
import type { Services } from '../container.js';
import { parseBody } from '../http.js';

const ResearchSchema = z.object({
  url: z.url().max(2000),
  question: z.string().trim().min(1).max(500).optional(),
  researchItemId: z.string().trim().min(1).max(64).optional(),
  providerId: z.string().trim().min(1).max(64).optional(),
});

export function researchRoutes(services: Services): Router {
  const router = Router();

  router.post('/cases/:caseId/research', async (request, response) => {
    if (!services.research) {
      throw new IdenoError(
        'bad_request',
        'Research is disabled on this server (IDENO_RESEARCH_ENABLED=0).',
      );
    }
    const body = parseBody(ResearchSchema, request.body);
    const outcome = await services.research.research({
      caseId: request.params.caseId,
      url: body.url,
      ...(body.question === undefined ? {} : { question: body.question }),
      ...(body.researchItemId === undefined ? {} : { researchItemId: body.researchItemId }),
      ...(body.providerId === undefined ? {} : { providerId: body.providerId }),
    });

    response.json({
      case: outcome.ideaCase,
      summary: summarizeState(outcome.ideaCase),
      changeset: outcome.changeset,
      sourceTitle: outcome.sourceTitle,
      claimsAccepted: outcome.claimsAccepted,
      claimsRejected: outcome.claimsRejected,
      answersQuestion: outcome.answersQuestion,
      researchSummary: outcome.summary,
      warnings: outcome.warnings,
    });
  });

  return router;
}
