import { Schema } from 'effect'

/** The outcome axis used by Onara HTTP errors. */
export const OnaraOutcome = Schema.Literals([
  'not_applied',
  'unknown',
  'applied',
])
export type OnaraOutcome = typeof OnaraOutcome.Type

/**
 * A typed refusal or failure returned by an Onara endpoint.
 *
 * `outcome` is explicit because an HTTP status alone cannot distinguish a
 * refusal before submission from a response lost after the server sent bytes.
 * `status` is the HTTP status; `txStatus` preserves the pre-Effect SDK's
 * `unconfirmed`/`unknown` field for consumers that still inspect it.
 */
export class OnaraError extends Schema.TaggedError<OnaraError>()('OnaraError', {
  message: Schema.String,
  status: Schema.Number,
  digest: Schema.optional(Schema.String),
  txStatus: Schema.optional(Schema.Literals(['unconfirmed', 'unknown'])),
  outcome: OnaraOutcome,
}) {}

/**
 * The server was configured for validation-only mode and answered a request
 * that asked for execution. This error is internal to the submission bridge;
 * the public SDK recovers it as the same `SponsorDryRunResponse` returned by
 * an explicit `dryRun:true` request.
 */
export class OnaraValidationOnly extends Schema.TaggedError<OnaraValidationOnly>()(
  'OnaraValidationOnly',
  {
    policy: Schema.String,
    moveCallTargets: Schema.Array(Schema.String),
    outcome: Schema.Literal('not_applied'),
  },
) {}
