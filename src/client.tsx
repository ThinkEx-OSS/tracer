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
import "./styles.css";

const sessionKey = "tracer-incident-thread";

function getSessionId() {
  const existing = localStorage.getItem(sessionKey);
  if (existing) return existing;

  const created = crypto.randomUUID();
  localStorage.setItem(sessionKey, created);
  return created;
}

function getText(message: UIMessage) {
  let text = "";
  for (const part of message.parts) {
    if (part.type === "text") text += part.text;
  }
  return text;
}

function App() {
  const [input, setInput] = useState("");
  const agent = useAgent({
    agent: "incident-thread",
    name: getSessionId(),
  });
  const { messages, sendMessage, status } = useAgentChat({ agent });
  const isBusy = status === "submitted" || status === "streaming";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isBusy) return;

    setInput("");
    void sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }

  return (
    <main className="app-shell bg-kumo-canvas text-kumo-default">
      <header className="topbar border-kumo-hairline">
        <div className="content-width topbar-content">
          <Text variant="heading3" as="h1">
            Tracer
          </Text>
          <Badge appearance="dot" variant={isBusy ? "info" : "success"}>
            {isBusy ? "Thinking" : "Ready"}
          </Badge>
        </div>
      </header>

      <section aria-label="Incident Thread" className="transcript">
        <div className="content-width messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-state">
              <Text variant="secondary">No active investigation.</Text>
            </div>
          ) : (
            messages.map((message) => (
              <article
                className={`message ${message.role === "user" ? "message-user bg-kumo-tint" : "message-assistant"}`}
                key={message.id}
              >
                <Text as="strong" bold size="xs">
                  {message.role === "user" ? "You" : "Tracer"}
                </Text>
                <Text>{getText(message)}</Text>
              </article>
            ))
          )}
        </div>
      </section>

      <footer className="composer-shell border-kumo-hairline bg-kumo-base">
        <form className="content-width composer" onSubmit={submit}>
          <InputArea
            aria-label="Message"
            className="composer-input"
            value={input}
            onValueChange={setInput}
            placeholder="Ask Tracer…"
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
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(<App />);
