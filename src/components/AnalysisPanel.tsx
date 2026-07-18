import { useEffect, useMemo } from "react";
import { analyzeComparison, type Finding, type FindingSeverity } from "../lib/findings";
import type { Session } from "../lib/types";
import { useStore } from "../state/store";
import OllamaSetup from "./OllamaSetup";

interface AnalysisPanelProps {
  a: Session;
  b: Session;
}

const SEVERITY_COLOR: Record<FindingSeverity, string> = {
  critical: "var(--color-bad)",
  warning: "var(--color-warn)",
  notable: "var(--color-accent)",
  info: "var(--color-line-2)",
};

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  notable: "Notable",
  info: "Info",
};

const CONFIDENCE_STYLE: Record<"high" | "medium" | "low", string> = {
  high: "bg-good/15 text-good",
  medium: "bg-warn/15 text-warn",
  low: "bg-surface-3 text-ink-3",
};

function FindingCard({ finding, aiText }: { finding: Finding; aiText: string | null }) {
  return (
    <div
      className="rounded-lg border border-line-2 bg-surface-2/60 p-3"
      style={{ borderLeftWidth: 4, borderLeftColor: SEVERITY_COLOR[finding.severity] }}
    >
      <div className="flex items-center gap-2">
        <span
          className="rounded px-1.5 py-px text-[0.6rem] font-semibold uppercase tracking-wider"
          style={{ color: SEVERITY_COLOR[finding.severity] }}
        >
          {SEVERITY_LABEL[finding.severity]}
        </span>
        <span className="font-medium">{finding.title}</span>
      </div>
      <p className="mt-1 text-[0.75rem] text-ink-2">{finding.detail}</p>
      {Object.keys(finding.metrics).length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {Object.entries(finding.metrics).map(([key, value]) => (
            <span
              key={key}
              className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[0.66rem] text-ink-2"
            >
              {key} {String(value)}
            </span>
          ))}
        </div>
      )}
      {aiText && (
        <div
          className="mt-2 rounded-md bg-accent/10 py-1.5 pl-2.5 pr-2 text-[0.75rem] leading-relaxed text-ink-2"
          style={{ borderLeft: "2px solid var(--color-accent)" }}
        >
          <span className="mr-1.5 rounded bg-accent/20 px-1 py-px text-[0.6rem] font-semibold text-accent-bright">
            AI
          </span>
          {aiText}
        </div>
      )}
    </div>
  );
}

export default function AnalysisPanel({ a, b }: AnalysisPanelProps) {
  const ollama = useStore((s) => s.ollama);
  const selectedModel = useStore((s) => s.selectedModel);
  const analysis = useStore((s) => s.analysis);
  const { refreshOllama, setSelectedModel, runLocalAnalysis, cancelLocalAnalysis } = useStore.getState();

  useEffect(() => {
    void refreshOllama();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const findings = useMemo(() => analyzeComparison({ a, b }), [a, b]);

  const key = `${a.id}|${b.id}`;
  const hasResult = analysis.result !== null && analysis.forKey === key;
  const result = hasResult ? analysis.result : null;

  const explanationById = useMemo(() => {
    const map = new Map<string, string>();
    if (result) {
      for (const e of result.explanations) map.set(e.id, e.text);
    }
    return map;
  }, [result]);

  const hasModels = Boolean(ollama?.reachable) && (ollama?.models.length ?? 0) > 0;
  const selectedInstalled = ollama?.models.some((m) => m.name === selectedModel) ?? false;
  const ready = ollama !== null && ollama.binaryInstalled && ollama.reachable && selectedInstalled;

  return (
    <div className="card card-enter p-4" style={{ animationDelay: "260ms" }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-ink-3">
          Deep analysis
        </h2>
        {findings.length > 0 && hasModels && (
          <div className="flex items-center gap-2">
            {analysis.status === "running" ? (
              <>
                <span className="font-mono text-[0.7rem] text-ink-3">
                  thinking · ~{Math.round(analysis.tokens)} tokens
                </span>
                <button
                  onClick={() => void cancelLocalAnalysis()}
                  className="rounded-lg border border-line-2 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-bad hover:text-bad"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}>
                  {ollama?.models.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => void runLocalAnalysis(a, b, findings)}
                  className="rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-bright"
                >
                  {analysis.status === "done" ? "Re-explain" : "Explain with local AI"}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {!ready && (
        <div className="mt-3 space-y-2">
          <OllamaSetup />
          <p className="text-[0.72rem] text-ink-3">
            No local AI? Use &quot;Export for AI…&quot; above to run the analysis in Claude or
            ChatGPT instead.
          </p>
        </div>
      )}

      {analysis.status === "error" && (
        <div className="mt-3 flex items-center gap-3">
          <span className="text-[0.78rem] text-bad">{analysis.error}</span>
          <button
            onClick={() => void runLocalAnalysis(a, b, findings)}
            className="rounded-lg border border-line-2 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-accent hover:text-ink"
          >
            Retry
          </button>
        </div>
      )}

      {findings.length === 0 ? (
        <p className="mt-3 text-[0.82rem] text-ink-2">
          No anomalies detected — both connections look clean in every analyzer.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {result && (
            <div className="rounded-lg border border-line-2 bg-surface-3/40 p-3">
              <div className="flex items-center gap-2">
                <h3 className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-ink-3">
                  AI summary
                </h3>
                <span
                  className={`rounded-full px-2 py-px text-[0.62rem] font-semibold uppercase tracking-wider ${CONFIDENCE_STYLE[result.confidence]}`}
                >
                  {result.confidence} confidence
                </span>
              </div>
              <p className="mt-1.5 text-[0.82rem] leading-relaxed text-ink-2">{result.summary}</p>
            </div>
          )}

          <div className="space-y-2">
            {findings.map((f) => (
              <FindingCard key={f.id} finding={f} aiText={explanationById.get(f.id) ?? null} />
            ))}
          </div>

          {result && result.recommendations.length > 0 && (
            <div className="rounded-lg border border-line-2 bg-surface-3/40 p-3">
              <h3 className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-ink-3">
                Recommendations
              </h3>
              <ol className="mt-1.5 space-y-1.5 text-[0.82rem] leading-relaxed text-ink-2">
                {[...result.recommendations]
                  .sort((x, y) => x.priority - y.priority)
                  .map((r, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="shrink-0 font-mono text-ink-3">{r.priority}.</span>
                      {r.text}
                    </li>
                  ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
