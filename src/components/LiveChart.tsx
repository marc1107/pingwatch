import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Sample } from "../lib/types";
import { fmtClock, fmtMs } from "../lib/format";

export interface ChartSeries {
  id: string;
  label: string;
  color: string;
  samples: Sample[];
}

interface Props {
  series: ChartSeries[];
  /** Fixed x-window: [minUtcMs, maxUtcMs]. */
  windowUtcMs: [number, number];
  thresholdMs: number;
  height?: number;
  /** "clock" renders wall-clock times; "elapsed" renders mm:ss offsets. */
  timeMode?: "clock" | "elapsed";
}

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface Extras {
  lossXs: number[][]; // per series, x positions (seconds) of lost pings
  thresholdMs: number;
}

const INK3 = "#5a6b7b";
const LINE = "#1a242d";

function buildData(series: ChartSeries[], minMs: number): { data: uPlot.AlignedData; extras: Extras } {
  const tables: uPlot.AlignedData[] = [];
  const lossXs: number[][] = [];
  for (const s of series) {
    const xs: number[] = [];
    const ys: (number | null)[] = [];
    const losses: number[] = [];
    for (const sample of s.samples) {
      if (sample.tUtcMs < minMs) continue;
      if (sample.rttMs === null) {
        losses.push(sample.tUtcMs / 1000);
      } else {
        xs.push(sample.tUtcMs / 1000);
        ys.push(sample.rttMs);
      }
    }
    tables.push([xs, ys] as unknown as uPlot.AlignedData);
    lossXs.push(losses);
  }
  const data =
    tables.length === 0
      ? ([[], []] as unknown as uPlot.AlignedData)
      : uPlot.join(tables);
  return { data, extras: { lossXs, thresholdMs: 0 } };
}

function drawExtras(u: uPlot, extras: Extras, colors: string[]) {
  const { ctx, bbox } = u;
  ctx.save();

  // Spike-threshold guide line.
  const yPos = u.valToPos(extras.thresholdMs, "y", true);
  if (yPos >= bbox.top && yPos <= bbox.top + bbox.height) {
    ctx.strokeStyle = "rgba(229, 72, 77, 0.45)";
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bbox.left, yPos);
    ctx.lineTo(bbox.left + bbox.width, yPos);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Packet-loss ticks: one row per series at the bottom of the plot.
  extras.lossXs.forEach((xs, si) => {
    if (xs.length === 0) return;
    ctx.fillStyle = colors[si];
    const y = bbox.top + bbox.height - 6 - si * 7;
    for (const x of xs) {
      const cx = u.valToPos(x, "x", true);
      if (cx < bbox.left || cx > bbox.left + bbox.width) continue;
      ctx.fillRect(cx - 1.5, y, 3, 5);
    }
  });
  ctx.restore();
}

function tooltipPlugin(
  seriesMeta: () => { label: string; color: string }[],
  timeMode: "clock" | "elapsed",
): uPlot.Plugin {
  let tip: HTMLDivElement;
  return {
    hooks: {
      init: (u) => {
        tip = document.createElement("div");
        tip.className = "chart-tooltip";
        tip.style.display = "none";
        u.over.appendChild(tip);
        u.over.addEventListener("mouseleave", () => {
          tip.style.display = "none";
        });
      },
      setCursor: (u) => {
        const { idx, left, top } = u.cursor;
        if (idx == null || left == null || left < 0 || top == null) {
          tip.style.display = "none";
          return;
        }
        const x = u.data[0][idx];
        if (x === undefined) {
          tip.style.display = "none";
          return;
        }
        const meta = seriesMeta();
        const rows = meta
          .map((m, si) => {
            const v = u.data[si + 1]?.[idx];
            return `<div style="display:flex;justify-content:space-between;gap:12px"><span><span style="color:${m.color}">●</span> ${m.label}</span><span>${v == null ? "–" : `${fmtMs(v as number)} ms`}</span></div>`;
          })
          .join("");
        const when = timeMode === "clock" ? fmtClock(x * 1000) : fmtElapsed(x);
        tip.innerHTML = `<div style="color:${INK3};margin-bottom:2px">${when}</div>${rows}`;
        tip.style.display = "block";
        const overW = u.over.clientWidth;
        const tipW = tip.clientWidth;
        tip.style.left = `${left + 14 + tipW > overW ? left - tipW - 14 : left + 14}px`;
        tip.style.top = `${Math.max(4, top - 10)}px`;
      },
    },
  };
}

export default function LiveChart({
  series,
  windowUtcMs,
  thresholdMs,
  height = 340,
  timeMode = "clock",
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const extrasRef = useRef<Extras>({ lossXs: [], thresholdMs });
  const metaRef = useRef(series.map((s) => ({ label: s.label, color: s.color })));
  metaRef.current = series.map((s) => ({ label: s.label, color: s.color }));

  const seriesKey = useMemo(() => series.map((s) => `${s.id}:${s.color}`).join("|"), [series]);

  // (Re)create the plot when the series set changes.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const opts: uPlot.Options = {
      width: root.clientWidth,
      height,
      ms: 0.001,
      padding: [12, 12, 0, 0],
      cursor: {
        y: false,
        points: { size: 7 },
      },
      legend: { show: false },
      scales: {
        x: { time: timeMode === "clock" },
        y: {
          range: (_u, _min, max) => [0, Math.max((max ?? 0) * 1.15, thresholdMs * 1.35, 25)],
        },
      },
      axes: [
        {
          stroke: INK3,
          font: "11px IBM Plex Mono",
          grid: { stroke: LINE, width: 1 },
          ticks: { stroke: LINE, width: 1 },
          ...(timeMode === "elapsed"
            ? { values: (_u: uPlot, vals: number[]) => vals.map(fmtElapsed) }
            : {}),
        },
        {
          stroke: INK3,
          font: "11px IBM Plex Mono",
          size: 52,
          grid: { stroke: LINE, width: 1 },
          ticks: { show: false },
          values: (_u, vals) => vals.map((v) => `${v} ms`),
        },
      ],
      series: [
        {},
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: 2,
          spanGaps: true,
          points: { show: false },
        })),
      ],
      plugins: [tooltipPlugin(() => metaRef.current, timeMode)],
      hooks: {
        draw: [
          (u) =>
            drawExtras(
              u,
              extrasRef.current,
              metaRef.current.map((m) => m.color),
            ),
        ],
      },
    };

    const plot = new uPlot(opts, [[], []] as unknown as uPlot.AlignedData, root);
    plotRef.current = plot;

    const ro = new ResizeObserver(() => {
      plot.setSize({ width: root.clientWidth, height });
    });
    ro.observe(root);

    return () => {
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesKey, height]);

  // Push new data on every sample/window change.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const [minMs, maxMs] = windowUtcMs;
    const { data, extras } = buildData(series, minMs);
    extras.thresholdMs = thresholdMs;
    extrasRef.current = extras;
    plot.setData(data, false);
    plot.setScale("x", { min: minMs / 1000, max: maxMs / 1000 });
  }, [series, windowUtcMs, thresholdMs]);

  return <div ref={rootRef} className="w-full" style={{ height }} />;
}
