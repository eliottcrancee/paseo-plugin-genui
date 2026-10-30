import { describe, expect, it } from "vitest";
import {
  buildChartHtml,
  CHART_TYPES,
  wheelTone,
  type ChartSeriesSpec,
  type ChartSpecInfo,
  type ChartType,
} from "./chartHtml";

function line(name: string, values: (number | null)[], extra: Partial<ChartSeriesSpec> = {}): ChartSeriesSpec {
  return { name, tone: "info", dashed: false, values, ...extra };
}

function spec(over: Partial<ChartSpecInfo> = {}): ChartSpecInfo {
  return {
    type: "bar",
    labels: ["Mon", "Tue", "Wed"],
    series: [line("Web", [3, 5, 2])],
    unit: "",
    title: null,
    xLabel: null,
    yLabel: null,
    stacked: false,
    donut: false,
    smooth: false,
    height: 260,
    showValues: false,
    orientation: "vertical",
    ...over,
  };
}

const CASES: Record<ChartType, ChartSpecInfo> = {
  bar: spec(),
  line: spec({ type: "line", series: [line("A", [3, 5, 2]), line("B", [1, 2, 4])] }),
  area: spec({ type: "area", smooth: true, series: [line("A", [3, 5, 2])] }),
  pie: spec({ type: "pie", series: [line("A", [3, 5, 2])], showValues: true }),
  scatter: spec({ type: "scatter", labels: ["1", "2", "3"], series: [line("A", [10, 12, 14])] }),
  radar: spec({ type: "radar", labels: ["Speed", "Weight", "Price", "Ports"], series: [line("Air", [3, 5, 2, 4])] }),
  funnel: spec({ type: "funnel", labels: ["Visit", "Trial", "Paid"], series: [line("A", [100, 40, 12])] }),
  heatmap: spec({
    type: "heatmap",
    labels: ["am", "pm"],
    series: [line("Mon", [1, null]), line("Tue", [0, 3])],
  }),
};

describe("chart html", () => {
  it("draws every chart type as one complete svg", () => {
    for (const type of CHART_TYPES) {
      const html = buildChartHtml(CASES[type]);
      expect(html, type).toContain("<svg");
      expect(html, type).toContain("</svg>");
      // A half-computed coordinate lands in the markup as one of these and the chart disappears.
      expect(html, type).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  it("escapes labels instead of writing markup", () => {
    const html = buildChartHtml(spec({ labels: ['a<b', 'x"y', "c&d"] }));
    expect(html).toContain("a&lt;b");
    expect(html).toContain("x&quot;y");
    expect(html).toContain("c&amp;d");
    expect(html).not.toContain("<b");
  });

  it("draws a bar for each sign of the value", () => {
    const html = buildChartHtml(spec({ labels: ["Q1", "Q2"], series: [line("Net", [-4, 6])] }));
    const rects = html.match(/<rect /g) ?? [];
    expect(rects).toHaveLength(2);
    // The negative bar hangs below the zero line, not collapsed to a 2px stub at it.
    const heights = [...html.matchAll(/<rect [^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(heights.every((height) => height > 2)).toBe(true);
  });

  it("stacks segments instead of drawing them side by side", () => {
    const html = buildChartHtml(
      spec({ labels: ["Mon"], stacked: true, series: [line("Web", [3]), line("Mobile", [5])] }),
    );
    const rects = [...html.matchAll(/<rect x="([\d.-]+)"[^>]*y="([\d.-]+)"[^>]*height="([\d.]+)"/g)];
    expect(rects).toHaveLength(2);
    // Same column, one piece on top of the other.
    expect(rects[0]![1]).toBe(rects[1]![1]);
    const tops = rects.map((m) => Number(m[2]));
    const occupied = rects.reduce((sum, m) => sum + Number(m[3]), 0);
    expect(Math.min(...tops)).toBeLessThan(Math.max(...tops));
    expect(occupied).toBeGreaterThan(0);
  });

  it("dashes a series only when asked", () => {
    const dashed = buildChartHtml(spec({ type: "line", series: [line("A", [1, 2, 3], { dashed: true })] }));
    expect(dashed).toContain('stroke-dasharray="5 4"');
    const solid = buildChartHtml(spec({ type: "line", series: [line("A", [1, 2, 3])] }));
    expect(solid).not.toContain("stroke-dasharray");
  });

  it("smoothes a line into curves", () => {
    const smooth = buildChartHtml(spec({ type: "line", smooth: true, series: [line("A", [1, 4, 2, 5])] }));
    expect(smooth).toMatch(/<path d="M[\d.,]+C/);
    const straight = buildChartHtml(spec({ type: "line", series: [line("A", [1, 4, 2, 5])] }));
    expect(straight).not.toMatch(/<path d="M[\d.,]+C/);
  });

  it("writes the title and both axis labels, with the unit as the y label by default", () => {
    const html = buildChartHtml(spec({ title: "Weekly PRs", xLabel: "Weekday", yLabel: "Pull requests" }));
    expect(html).toContain('<div class="g-title">Weekly PRs</div>');
    expect(html).toContain("Weekday");
    expect(html).toContain("Pull requests");
  });

  it("prints the total in the middle of a donut", () => {
    const html = buildChartHtml(
      spec({ type: "pie", donut: true, showValues: true, unit: "tok", series: [line("A", [60, 40])] }),
    );
    expect(html).toContain("100 tok");
    expect(html).toContain("total");
  });

  it("lays a horizontal bar chart out as rows with the labels on the left", () => {
    const html = buildChartHtml(
      spec({ orientation: "horizontal", labels: ["Visits", "Paid"], series: [line("A", [100, 20])], showValues: true }),
    );
    expect(html).toContain(">Visits<");
    expect(html).toContain("100");
    // The row labels anchor to the same right edge, left of every bar.
    const labelXs = [...html.matchAll(/<text x="([\d.]+)" y="[\d.]+" text-anchor="end" font-size="11.5"/g)].map((m) =>
      Number(m[1]),
    );
    const barXs = [...html.matchAll(/<rect x="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(labelXs).toHaveLength(2);
    expect(new Set(labelXs).size).toBe(1);
    expect(Math.max(...labelXs)).toBeLessThan(Math.min(...barXs));
  });

  it("keeps percentages adding up to 100 across the pie legend", () => {
    const html = buildChartHtml(spec({ type: "pie", labels: ["a", "b", "c"], series: [line("A", [1, 1, 1])] }));
    const shares = [...html.matchAll(/· (\d+)%/g)].map((m) => Number(m[1]));
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(100);
  });

  it("says so when there is nothing to draw", () => {
    expect(buildChartHtml(spec({ labels: [] }))).toContain("No data");
  });

  it("paints each series with the tone it carries", () => {
    const html = buildChartHtml(
      spec({ type: "line", series: [line("A", [1, 2, 3]), line("B", [3, 2, 1], { tone: "warn" })] }),
    );
    expect(html).toContain('stroke="var(--primary)"');
    expect(html).toContain('stroke="var(--warning)"');
    // The legend agrees with the strokes.
    expect(html).toContain("background:var(--warning)");
  });

  it("wraps the colour wheel so every series stays in the theme", () => {
    expect(wheelTone(5)).toBe(wheelTone(0));
    expect(wheelTone(-1)).toBe(wheelTone(4));
  });
});
