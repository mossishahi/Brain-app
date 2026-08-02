/** Stage 1 — Process input: the classifier's facts, question, context, and file map. */
import { useState } from "react";
import type {
  AnnotatedFileView,
  FilePartitionView,
  ProcessorOutputView,
} from "@brainstorm-agentic/protocol";
import { Clamp } from "../common";

/** Last path segments so long snapshot paths stay scannable; full path on hover. */
function shortPath(path: string, segments = 3): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join("/")}`;
}

function FileTable({ files }: { files: readonly AnnotatedFileView[] }) {
  return (
    <table className="paper-table file-table">
      <thead>
        <tr>
          <th>File</th>
          <th>Label</th>
          <th>Relation</th>
        </tr>
      </thead>
      <tbody>
        {files.map((file) => (
          <tr key={file.path}>
            <td className="file-path" title={file.path}>
              {shortPath(file.path)}
            </td>
            <td>
              <span className="tag">{file.label}</span>
            </td>
            <td>
              {file.note || "—"}
              {file.codeSummary && (
                <div className="dim small">{file.codeSummary}</div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Lists longer than this open collapsed; short maps stay visible at a glance. */
const COLLAPSE_FILES_ABOVE = 12;

/** The orchestrator's file partition: what later calls see vs what was dropped. */
function FilePartition({ files }: { files: FilePartitionView }) {
  const [showFiles, setShowFiles] = useState(
    files.useful.length <= COLLAPSE_FILES_ABOVE,
  );
  const [showIgnored, setShowIgnored] = useState(false);
  return (
    <div className="file-partition">
      <p className="section-label">
        Files sent to the panel ({files.useful.length})
      </p>
      {files.useful.length > 0 ? (
        <>
          <button
            type="button"
            className="more-btn"
            onClick={() => setShowFiles((v) => !v)}
          >
            {showFiles ? "hide" : "show"} the file map ({files.useful.length})
          </button>
          {showFiles && (
            <div className="file-scroll">
              <FileTable files={files.useful} />
            </div>
          )}
        </>
      ) : (
        <p className="dim small">no useful files — every file was labeled NA</p>
      )}
      {files.ignored.length > 0 && (
        <>
          <button
            type="button"
            className="more-btn"
            onClick={() => setShowIgnored((v) => !v)}
          >
            {showIgnored ? "hide" : "show"} ignored files ({files.ignored.length}
            , labeled NA — removed from all later model calls)
          </button>
          {showIgnored && (
            <div className="file-scroll">
              <ul className="ignored-list">
                {files.ignored.map((file) => (
                  <li key={file.path} title={file.path}>
                    <span className="file-path">{shortPath(file.path)}</span>
                    {file.note && <span className="dim small"> — {file.note}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ProcessInputBody({
  output,
  files,
}: {
  output: ProcessorOutputView;
  files?: FilePartitionView;
}) {
  return (
    <div>
      <div className="fact-row">
        {/* What kind of submission this is; shapes the First pass primary tab. */}
        <span className="chip chip-accent">{output.type}</span>
        <span className="chip chip-dim">{output.cotSteps} chain steps</span>
      </div>
      <h3 className="artifact-title">{output.title}</h3>
      <blockquote className="question">{output.question}</blockquote>
      <Clamp text={output.context} />
      {output.requestedOutputs && output.requestedOutputs.length > 0 && (
        <>
          {/* Explicit deliverables the submitter asked for: every panel
              member's output must answer each one with a dedicated section. */}
          <p className="section-label">
            Requested outputs ({output.requestedOutputs.length})
          </p>
          <ul className="assumptions">
            {output.requestedOutputs.map((requested) => (
              <li key={requested.title}>
                <strong>{requested.title}</strong>
                <span className="dim"> — {requested.ask}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="section-label">Assumptions</p>
      {output.assumptions.length > 0 ? (
        <ul className="assumptions">
          {output.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : (
        <p className="dim small">no assumptions detected</p>
      )}
      {output.attachments.length > 0 && (
        <>
          <p className="section-label">Attachments</p>
          <div className="attachment-row">
            {output.attachments.map((att) => (
              <span key={att.name} className="chip chip-file" title={att.note}>
                <strong>{att.name}</strong>
                <span className="chip-note">{att.note}</span>
              </span>
            ))}
          </div>
        </>
      )}
      {files && <FilePartition files={files} />}
    </div>
  );
}
