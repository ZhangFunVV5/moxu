import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkspaceInfo } from "../shared/book";
import { SampleApp } from "./SampleApp";
import { WorkspaceApp } from "./WorkspaceApp";
import "./styles.css";

function Root() {
  const [startupError, setStartupError] = useState("");
  const [state, setState] = useState<WorkspaceInfo | null | undefined>(
    undefined,
  );
  useEffect(() => {
    void window.desktop.workspace.state().then((result) => {
      if (!result.ok) setStartupError(`${result.error.code}：${result.error.message}`);
      setState(result.ok ? result.data : null);
    });
  }, []);
  useEffect(() => {
    if (state) return;
    return window.desktop.lifecycle.onCloseRequested(() => {
      void window.desktop.lifecycle.confirmClose({ action: "close" });
    });
  }, [state]);
  if (state === undefined)
    return (
      <div id="book-agent-blue">
        <section className="bb-shell bb-booting" aria-live="polite">
          正在打开工作区…
        </section>
      </div>
    );
  if (state === null) return <SampleApp startupError={startupError} onOpened={(next) => {
    setStartupError("");
    setState(next);
  }} />;
  return <WorkspaceApp initial={state} onClosed={() => setState(null)} />;
}

createRoot(document.getElementById("root")!).render(<Root />);
