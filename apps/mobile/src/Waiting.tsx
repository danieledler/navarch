import { CheckCircle2, ExternalLink } from "lucide-react";
import type { Session, SessionStatus } from "../../../src/api/types";
import { baseName, relTime } from "../../../src/lib/format";
import { isLive, needsAttention, type Model } from "../../../src/lib/model";
import { useNow } from "./time";

export const STATUS_LABEL: Record<SessionStatus, string> = {
  working: "Working",
  needs_input: "Needs your input",
  unread: "New reply",
  idle: "Idle",
  stopped: "Interrupted",
};

const newestFirst = (a: Session, b: Session) => b.lastActivityAt - a.lastActivityAt;

/** Sessions that wait for you (in imported projects, like the desktop's badge), then what's running now. */
export function Waiting({ m }: { m: Model }) {
  useNow();
  const waiting = m.sessions.filter((s) => needsAttention(s) && m.projectOf.has(s.id)).sort(newestFirst);
  const shown = new Set(waiting.map((s) => s.id));
  const running = m.sessions.filter((s) => !s.archived && isLive(s) && !shown.has(s.id)).sort(newestFirst);
  const projectName = (s: Session) => {
    const pid = m.projectOf.get(s.id);
    return pid != null ? m.project.get(pid)?.name : baseName(s.launchPath ?? s.cwd);
  };

  return (
    <>
      {waiting.length ? (
        <div className="section">
          <div className="group">
            {waiting.map((s) => (
              <WaitingCard key={s.id} s={s} project={projectName(s)} />
            ))}
          </div>
        </div>
      ) : (
        <div className="empty">
          <CheckCircle2 size={36} />
          <strong>Nothing is waiting</strong>
          Sessions that ask a question or finish a reply you haven't read show up here.
        </div>
      )}
      {running.length > 0 && (
        <div className="section">
          <div className="section-label">Running now</div>
          <div className="group">
            {running.map((s) => (
              <div key={s.id} className="row">
                <span className={`dot status-${s.status}`} />
                <div className="row-main">
                  <div className="row-title">{s.title || "Untitled session"}</div>
                  <div className="meta">{projectName(s)}</div>
                </div>
                <span className="row-side">{relTime(s.lastActivityAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function WaitingCard({ s, project }: { s: Session; project?: string }) {
  return (
    <article className="card">
      <div className="card-title">{s.title || "Untitled session"}</div>
      <div className="meta">
        {project && <span>{project}</span>}
        <span className={`status status-${s.status}`}>{STATUS_LABEL[s.status]}</span>
        <span>{relTime(s.lastActivityAt)}</span>
      </div>
      {s.lastReply && <p className="reply">{s.lastReply}</p>}
      {s.lastPrompt && <p className="prompt">You: {s.lastPrompt}</p>}
      {s.remoteId && (
        <a className="open-link" href={`https://claude.ai/code/${encodeURIComponent(s.remoteId)}`}>
          Open in Claude <ExternalLink size={15} />
        </a>
      )}
    </article>
  );
}
