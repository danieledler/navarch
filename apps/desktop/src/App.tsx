import { useEffect } from "react";
import { useModel, useStore } from "./store";
import { SpaceRail } from "./components/SpaceRail";
import { ProjectList } from "./components/ProjectList";
import { ProjectView } from "./components/ProjectView";
import { FocusPanel } from "./components/FocusPanel";
import { Dashboard } from "./components/Dashboard";
import { StatusBar } from "./components/StatusBar";
import { Toasts } from "./components/Toasts";

export function App() {
  const ready = useStore((s) => s.ready);
  const init = useStore((s) => s.init);
  const view = useStore((s) => s.view);

  useEffect(() => {
    init();
  }, [init]);

  if (!ready) return <div className="loading">Loading…</div>;

  return (
    <div className="app">
      <SpaceRail />
      {view.kind === "dashboard" ? <Dashboard /> : <SpaceView spaceId={view.spaceId} />}
      <FocusPanel spaceId={view.kind === "space" ? view.spaceId : null} />
      <StatusBar />
      <Toasts />
    </div>
  );
}

function SpaceView({ spaceId }: { spaceId: number }) {
  const m = useModel();
  const chosen = useStore((s) => s.projectOfSpace[spaceId]);
  const projects = m.projects.filter((p) => p.spaceId === spaceId);
  const projectId = projects.some((p) => p.id === chosen) ? chosen : projects[0]?.id;
  return (
    <>
      <ProjectList spaceId={spaceId} />
      {projectId != null ? (
        <ProjectView key={projectId} projectId={projectId} />
      ) : (
        <section className="main">
          <header className="main-head" data-tauri-drag-region />
          <div className="empty-main">
            <h3>No projects in {m.space.get(spaceId)?.name} yet</h3>
            <p className="muted">Add a folder on the left, or import one of your Claude session folders from the Overview.</p>
          </div>
        </section>
      )}
    </>
  );
}
