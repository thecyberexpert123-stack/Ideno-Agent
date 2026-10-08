import { z } from 'zod';

/**
 * Renderer-independent canonical representation.
 *
 * This is the contract an Ideno representation plugin consumes:
 *
 *     Idea State → Canonical Representation → renderer (Three.js, CAD, …)
 *
 * The point is that a renderer never receives free-form natural language and
 * never invents its own model. It receives this document, derived from the
 * Idea State, and draws exactly what it describes. Swapping Three.js for a
 * CAD backend then changes nothing upstream.
 *
 * v0.1 defines the contract and ships no renderer and no extractor. Nothing
 * in the running application produces one of these documents yet; publishing
 * a fabricated geometry derived from prose would be exactly the failure mode
 * this contract exists to prevent.
 */

export const LengthUnitSchema = z.enum(['mm', 'cm', 'm', 'in']);
export type LengthUnit = z.infer<typeof LengthUnitSchema>;

export const QuantitySchema = z.object({
  value: z.number().finite(),
  unit: LengthUnitSchema,
});
export type Quantity = z.infer<typeof QuantitySchema>;

export const GeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('box'), width: QuantitySchema, height: QuantitySchema, depth: QuantitySchema }),
  z.object({ type: z.literal('cylinder'), radius: QuantitySchema, height: QuantitySchema }),
  z.object({ type: z.literal('sphere'), radius: QuantitySchema }),
  z.object({ type: z.literal('unspecified') }),
]);
export type Geometry = z.infer<typeof GeometrySchema>;

export const CanonicalObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  geometry: GeometrySchema,
  /** Idea State item ids this object is derived from. Required: no orphans. */
  derived_from: z.array(z.string()).min(1),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type CanonicalObject = z.infer<typeof CanonicalObjectSchema>;

export const CanonicalConnectionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(['flow', 'mechanical', 'electrical', 'data']),
  label: z.string().max(120).optional(),
  derived_from: z.array(z.string()).min(1),
});
export type CanonicalConnection = z.infer<typeof CanonicalConnectionSchema>;

export const CanonicalConstraintSchema = z.object({
  target: z.string().min(1),
  name: z.string().min(1).max(80),
  value: z.union([z.string(), z.number(), z.boolean()]),
  derived_from: z.array(z.string()).min(1),
});
export type CanonicalConstraint = z.infer<typeof CanonicalConstraintSchema>;

export const CanonicalDocumentSchema = z.object({
  case_id: z.string().min(1),
  /** Idea State version this document was derived from. */
  version: z.number().int().min(0),
  generated_at: z.iso.datetime(),
  objects: z.array(CanonicalObjectSchema).default([]),
  connections: z.array(CanonicalConnectionSchema).default([]),
  constraints: z.array(CanonicalConstraintSchema).default([]),
});
export type CanonicalDocument = z.infer<typeof CanonicalDocumentSchema>;
