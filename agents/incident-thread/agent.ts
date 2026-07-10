import { Think } from "@cloudflare/think";

/** The durable investigation transcript and case record for one Anomaly. */
export class IncidentThread extends Think<Cloudflare.Env> {
  async submitMonitorBriefing(input: { idempotencyKey: string; prompt: string }) {
    await this.runTurn({
      mode: "submit",
      idempotencyKey: input.idempotencyKey,
      input: input.prompt,
    });
  }

  override getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  override getSystemPrompt() {
    return [
      "You investigate software infrastructure incidents.",
      "First triage monitor briefings conservatively; a deterministic deviation is a candidate, not a confirmed incident.",
      "Default to no anomaly when evidence is sparse, expected, or explained by workload mix.",
      "Separate observations from hypotheses and conclusions.",
      "Do not claim a cause or resolution without supporting evidence.",
      "This project is only scaffolded, so be explicit when a required tool is not available.",
    ].join(" ");
  }
}
