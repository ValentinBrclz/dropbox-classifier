/**
 * Cloudflare Workflow entrypoint. All logic lives in steps.ts (testable in
 * Node); this class only wires bindings and secrets.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { buildDeps } from "./deps.ts";
import type { JobMessage } from "./outbox.ts";
import { type StepLike, runPipeline } from "./steps.ts";

export class ClassifierWorkflow extends WorkflowEntrypoint<Env, JobMessage> {
	async run(event: WorkflowEvent<JobMessage>, step: WorkflowStep): Promise<void> {
		await runPipeline(buildDeps(this.env), step as unknown as StepLike, event.payload);
	}
}
