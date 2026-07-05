/**
 * PRD-011a tenancy wire contract: mirrors the honeycomb PRD-073c `/setup/tenancy` family
 * field-for-field (pinned at implementation). Same discipline as `contracts.ts` for PRD-009b:
 * local types at the onboarding boundary, zod with `.catch()` defaults, never throw into React.
 */

import { z } from "zod";

/** `{ id, name }` pair returned by org/workspace enumeration and select acks. */
export const TenancyEntitySchema = z.object({
	id: z.string().catch(""),
	name: z.string().catch(""),
});
export type TenancyEntityWire = z.infer<typeof TenancyEntitySchema>;

/**
 * `GET /setup/tenancy`: the durable selected marker and current org/workspace read.
 * `selected` is true ONLY after the daemon has persisted a confirmation. Reconciled against the
 * honeycomb implementation (2026-07-04): the earlier proposed `autoSelected` field was REMOVED
 * from the daemon contract (an auto-selection persists immediately and reads as `selected: true`,
 * so no GET ever carries it); `confirmedBy` was ADDED and reports how the confirmation happened
 * (`selection` = an explicit POST /setup/tenancy/select; `grandfathered` = a pre-PRD-073 credential
 * whose existing tenancy was carried forward).
 */
export const SetupTenancySchema = z.object({
	pending: z.boolean().catch(true),
	selected: z.boolean().catch(false),
	authenticated: z.boolean().catch(false),
	org: TenancyEntitySchema.nullable().catch(null),
	workspace: TenancyEntitySchema.nullable().catch(null),
	// `.catch(undefined)` keeps the module's fail-soft rule: a malformed confirmedBy value must
	// degrade to "absent" (the field is cosmetic), never fail the whole tenancy read.
	confirmedBy: z.enum(["selection", "grandfathered"]).optional().catch(undefined),
});
export type SetupTenancyWire = z.infer<typeof SetupTenancySchema>;

/** Honest default when the tenancy read fails or the body is malformed. */
export const UNSELECTED_SETUP_TENANCY: SetupTenancyWire = Object.freeze({
	pending: true,
	selected: false,
	authenticated: false,
	org: null,
	workspace: null,
});

/** `GET /setup/tenancy/orgs` body. */
export const TenancyOrgsSchema = z.object({
	orgs: z.array(TenancyEntitySchema).catch([]),
});
export type TenancyOrgsWire = z.infer<typeof TenancyOrgsSchema>;

export const EMPTY_TENANCY_ORGS: TenancyOrgsWire = Object.freeze({ orgs: [] });

/** `GET /setup/tenancy/workspaces?org=` body. */
export const TenancyWorkspacesSchema = z.object({
	org: z.string().catch(""),
	workspaces: z.array(TenancyEntitySchema).catch([]),
	canCreate: z.boolean().catch(false),
});
export type TenancyWorkspacesWire = z.infer<typeof TenancyWorkspacesSchema>;

export const EMPTY_TENANCY_WORKSPACES: TenancyWorkspacesWire = Object.freeze({
	org: "",
	workspaces: [],
	canCreate: false,
});

/** Successful `POST /setup/tenancy/select` ack. */
export const TenancySelectOkSchema = z.object({
	selected: z.literal(true),
	org: TenancyEntitySchema,
	workspace: TenancyEntitySchema,
	reminted: z.boolean().catch(false),
});

/** Failed `POST /setup/tenancy/select` ack (redacted reason, no token). */
export const TenancySelectErrSchema = z.object({
	selected: z.literal(false),
	error: z.string().catch("Selection could not be saved."),
});

export const TenancySelectResponseSchema = z.union([TenancySelectOkSchema, TenancySelectErrSchema]);
export type TenancySelectResponseWire = z.infer<typeof TenancySelectResponseSchema>;

/** Successful `POST /setup/tenancy/workspaces` ack. */
export const TenancyCreateOkSchema = z.object({
	created: z.literal(true),
	workspace: TenancyEntitySchema,
});

/** Failed `POST /setup/tenancy/workspaces` ack. */
export const TenancyCreateErrSchema = z.object({
	created: z.literal(false),
	error: z.string().catch("Workspace could not be created."),
});

export const TenancyCreateResponseSchema = z.union([TenancyCreateOkSchema, TenancyCreateErrSchema]);
export type TenancyCreateResponseWire = z.infer<typeof TenancyCreateResponseSchema>;
