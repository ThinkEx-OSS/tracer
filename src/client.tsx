import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { InputArea } from "@cloudflare/kumo/components/input";
import { Text } from "@cloudflare/kumo/components/text";
import { useAgentChat } from "@cloudflare/think/react";
import { PaperPlaneRightIcon } from "@phosphor-icons/react/PaperPlaneRight";
import type { UIMessage } from "ai";
import { useAgent } from "agents/react";
import type { FormEvent } from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createInitialWorkspaceState, type WorkspaceState } from "../shared/workspace";
import { workspaceConfig } from "../workspace.config";
import { CheckCard } from "./check-card";
import "./styles.css";

function getText(message: UIMessage) {
  let text = "";
  for (const part of message.parts) {
    if (part.type === "text") text += part.text;
  }
  return text;
}

function workspaceStatus(status: WorkspaceState["status"]) {
  if (status === "ready") return { label: "Monitoring", variant: "success" as const };
  if (status === "checking") return { label: "Checking now", variant: "info" as const };
  if (status === "partial") return { label: "Limited context", variant: "warning" as const };
  if (status === "failed") return { label: "Check failed", variant: "error" as const };
  return { label: "Connecting", variant: "neutral" as const };
}

function App() {
  const [input, setInput] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceState>(() =>
    createInitialWorkspaceState(workspaceConfig.checks),
  );
  const [checkError, setCheckError] = useState<string>();
  const workspaceAgent = useAgent<WorkspaceState>({
    agent: "workspace-monitor",
    name: workspaceConfig.id,
    onStateUpdate: setWorkspace,
  });
  const incidentThreadId = workspace.activeInvestigation?.threadId ?? workspaceConfig.id;
  const incidentAgent = useAgent({
    agent: "incident-thread",
    name: incidentThreadId,
  });
  const { messages, sendMessage, status } = useAgentChat({ agent: incidentAgent });
  const isBusy = status === "submitted" || status === "streaming";
  const monitorStatus = workspaceStatus(workspace.status);
  const investigationLabel = isBusy
    ? "Investigating"
    : messages.length > 0
      ? "Conversation open"
      : workspace.activeInvestigation
        ? "Investigation queued"
        : "No open case";

  async function runCheck() {
    setCheckError(undefined);
    try {
      const nextState = await workspaceAgent.call<WorkspaceState>("reconcile", [], {
        timeout: 60_000,
      });
      setWorkspace(nextState);
    } catch {
      setCheckError("The check could not run. Verify provider access and try again.");
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isBusy) return;

    setInput("");
    void sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }

  return (
    <div className="app-shell bg-kumo-canvas text-kumo-default">
      <header className="topbar border-kumo-hairline">
        <div className="content-width topbar-content">
          <Text variant="heading3" as="h1">
            Tracer
          </Text>
          <Badge appearance="dot" variant={monitorStatus.variant}>
            {monitorStatus.label}
          </Badge>
        </div>
      </header>

      <main className="transcript">
        <div className="content-width workspace-content">
          <CheckCard error={checkError} onRun={() => void runCheck()} workspace={workspace} />

          <section aria-labelledby="investigation-title" className="investigation">
            <div className="section-heading">
              <div>
                <Text as="h2" id="investigation-title" variant="heading3">
                  Investigation
                </Text>
                <Text variant="secondary">
                  Tracer opens a case when a check finds a meaningful change.
                </Text>
              </div>
              <Badge appearance="dot" variant={isBusy ? "info" : "neutral"}>
                {investigationLabel}
              </Badge>
            </div>

            <div className="messages" aria-live="polite">
              {messages.length === 0 ? (
                <div className="empty-state">
                  <Text variant="secondary">
                    {workspace.activeInvestigation
                      ? "A monitor finding is queued for triage."
                      : "Nothing needs investigation. Monitoring continues in the background."}
                  </Text>
                </div>
              ) : (
                messages.map((message) => {
                  const text = getText(message);
                  const monitorBriefing = text.startsWith("[TRACER_MONITOR_BRIEFING]");
                  return (
                    <article
                      className={`message ${message.role === "user" ? "message-user bg-kumo-tint" : "message-assistant"}`}
                      key={message.id}
                    >
                      <Text as="strong" bold size="xs">
                        {message.role === "user" ? (monitorBriefing ? "Monitor" : "You") : "Tracer"}
                      </Text>
                      <Text>
                        {monitorBriefing
                          ? "Production monitoring submitted a candidate deviation for triage."
                          : text}
                      </Text>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </main>

      <footer className="composer-shell border-kumo-hairline bg-kumo-base">
        <form className="content-width composer" onSubmit={submit}>
          <InputArea
            aria-label="Message"
            className="composer-input"
            value={input}
            onValueChange={setInput}
            placeholder="Ask about this workspace…"
            rows={1}
          />
          <Button
            aria-label="Send message"
            disabled={isBusy || input.trim().length === 0}
            icon={<PaperPlaneRightIcon aria-hidden="true" />}
            loading={isBusy}
            shape="square"
            type="submit"
            variant="primary"
          />
        </form>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(<App />);
