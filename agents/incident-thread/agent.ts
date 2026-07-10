import { Think } from "@cloudflare/think";

/** The durable investigation transcript and case record for one Anomaly. */
export class IncidentThread extends Think<Cloudflare.Env> {
  override getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  override getSystemPrompt() {
    return [
      "You investigate software infrastructure incidents.",
      "Separate observations from hypotheses and conclusions.",
      "Do not claim a cause or resolution without supporting evidence.",
      "This project is only scaffolded, so be explicit when a required tool is not available.",
    ].join(" ");
  }
}
