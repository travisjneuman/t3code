/**
 * Fork add-on: HTTPS-only release mirrors for the SSH runner. The remote script verifies the
 * archive against SHA256SUMS fetched from the same base, so a plain-HTTP mirror lets anyone on
 * the path swap both.
 *
 * @module ssh/releaseMirror
 */
import { cliReleaseBaseUrlProblem } from "@t3tools/shared/cliRelease";
import * as Schema from "effect/Schema";

export class SshInsecureReleaseMirrorError extends Schema.TaggedError<SshInsecureReleaseMirrorError>()(
  "SshInsecureReleaseMirrorError",
  { problem: Schema.String },
) {
  override get message(): string {
    return `Refusing to install t3 over SSH from this release mirror. ${this.problem}`;
  }
}

/** Throws like the runner script's other input checks; an unset base uses the HTTPS default. */
export function assertSshReleaseMirror(releaseBaseUrl: string | null | undefined): void {
  const problem = cliReleaseBaseUrlProblem(releaseBaseUrl ?? undefined);
  if (problem !== undefined) throw new SshInsecureReleaseMirrorError({ problem });
}
