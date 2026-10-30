import { Icon, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { InlineMarkdown } from "../markdown";
import { buildChartHtml, CHART_TYPES, wheelTone, type ChartSpecInfo } from "../../shared/logic/chartHtml";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { calendarLayout, calendarStats, dayLabel, readDays } from "../../shared/logic/calendarMath";
import { formatShare, funnelStages, percentages, pieSlices } from "../../shared/logic/chartMath";
import { canRenderWebIframe, mountSandboxedAppIframe } from "../web";
import { buildTree, defaultExpanded, timelineEntries, visibleRows } from "../../shared/logic/content-model";
import {
  addMonths,
  dayKey,
  initialMonth,
  localToday,
  monthKey,
  monthWeeks,
  parseEvents,
  parseMonth,
} from "../../shared/logic/explain-logic";
import {
  asRecord,
  finiteNumber,
  formatNumber,
  isNode,
  isObject,
  list,
  optionalText,
  text,
  tone,
  type Props,
  type Tone,
} from "../../shared/logic/values";
import { ErrorLine, RenderNode } from "../node-renderer";
import { InTableContext, propsKey, toneColor, usePersistedState, useUiRuntime } from "../runtime";

export function Table({ props }: { props: Props }) {
  const { theme, compact } = useUiRuntime();
  const columns = list(props.columns).map((col) => {
    const rec = asRecord(col);
    return rec ? text(rec.label ?? rec.key) : text(col);
  });
  const rows = list(props.rows);

  return (
    <InTableContext.Provider value={true}>
      <ScrollView horizontal showsHorizontalScrollIndicator={!compact}>
        <View
          style={{
            borderRadius: 8,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.border,
            overflow: "hidden",
            minWidth: "100%",
          }}
        >
          <View
            style={{
              flexDirection: "row",
              backgroundColor: theme.colors.surface2,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.colors.border,
            }}
          >
            {columns.map((col, idx) => (
              <View
                key={`${col}:${idx}`}
                style={{ flex: 1, minWidth: 110, paddingHorizontal: 10, paddingVertical: 8 }}
              >
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
                  {col}
                </Text>
              </View>
            ))}
          </View>
          {rows.map((row, rIdx) => {
            const rec = asRecord(row);
            const cells = Array.isArray(row)
              ? row
              : rec
                ? columns.map((c) => rec[c] ?? null)
                : [row];
            return (
              <View
                key={rIdx}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  borderTopWidth: rIdx === 0 ? 0 : StyleSheet.hairlineWidth,
                  borderTopColor: theme.colors.border,
                }}
              >
                {columns.map((_, cIdx) => {
                  const cell = cells[cIdx];
                  return (
                    <View
                      key={cIdx}
                      style={{ flex: 1, minWidth: 110, paddingHorizontal: 10, paddingVertical: 8 }}
                    >
                      {isNode(cell) ? (
                        <RenderNode node={cell} />
                      ) : (
                        <Text selectable style={{ color: theme.colors.foreground, fontSize: 12.5 }}>
                          {text(cell)}
                        </Text>
                      )}
                    </View>
                  );
                })}
              </View>
            );
          })}
        </View>
      </ScrollView>
    </InTableContext.Provider>
  );
}

interface ParsedSeries {
  name: string;
  values: (number | null)[];
  tone: Tone;
  dashed?: boolean;
}

/** A chart value read with its unit, the way the SVG charts print them. */
function formatVal(v: number, unit: string): string {
  const shown = formatNumber(v);
  return unit ? `${shown} ${unit}` : shown;
}

function parseChartSeries(raw: unknown): ParsedSeries[] {
  if (Array.isArray(raw)) {
    return [
      {
        name: "Value",
        values: raw.map((v) => finiteNumber(v)),
        tone: "info",
      },
    ];
  }
  if (isObject(raw)) {
    // A series with no tone of its own takes the next wheel color, the way the SVG charts do.
    return Object.entries(raw).map(([name, entry], idx) => {
      if (Array.isArray(entry)) {
        return { name, values: entry.map((v) => finiteNumber(v)), tone: wheelTone(idx) };
      }
      if (isObject(entry) && Array.isArray(entry.values)) {
        return {
          name,
          values: entry.values.map((v) => finiteNumber(v)),
          tone: tone(entry.tone as never),
          dashed: entry.dashed === true,
        };
      }
      return { name, values: [], tone: wheelTone(idx) };
    });
  }
  return [];
}

function chartSpecInfo(props: Props, series: ParsedSeries[]): ChartSpecInfo {
  const rawType = text(props.type);
  const type = CHART_TYPES.find((t) => t === rawType) ?? "bar";
  const unit = optionalText(props.unit) ?? "";
  const height = Math.round(Math.min(560, Math.max(150, finiteNumber(props.height) ?? 260)));
  const allDashed = props.dashed === true;
  const showValuesRaw = props.showValues;
  const showValues =
    showValuesRaw === true
      ? true
      : showValuesRaw === false
        ? false
        : type === "pie" || type === "funnel" || type === "heatmap";
  return {
    type,
    labels: list(props.labels).map((l) => text(l)),
    series: series.map((s) => ({ name: s.name, tone: s.tone, dashed: s.dashed ?? allDashed, values: s.values })),
    unit,
    title: optionalText(props.title),
    xLabel: optionalText(props.xLabel),
    yLabel: optionalText(props.yLabel) ?? (unit || null),
    stacked: props.stacked === true,
    donut: props.donut === true,
    smooth: props.smooth === true,
    height,
    showValues,
    orientation: text(props.orientation) === "horizontal" ? "horizontal" : "vertical",
  };
}

export function Chart({ props }: { props: Props }) {
  const series = useMemo(() => parseChartSeries(props.series), [props.series]);
  const spec = useMemo(() => (series.length === 0 ? null : chartSpecInfo(props, series)), [props, series]);
  if (spec === null) return <ErrorLine message="Chart series is empty" />;
  if (canRenderWebIframe()) return <ChartSandbox spec={spec} />;
  return <ChartNative spec={spec} />;
}

/** Web/desktop: each type is a real SVG chart inside the theme-injecting sandbox iframe. */
function ChartSandbox({ spec }: { spec: ChartSpecInfo }) {
  const { theme } = useUiRuntime();
  const containerRef = useRef<View>(null);
  const [height, setHeight] = useState(spec.height);
  const [error, setError] = useState<string | null>(null);
  const html = useMemo(() => buildChartHtml(spec), [spec]);
  useEffect(() => {
    if (!containerRef.current) return;
    setError(null);
    return mountSandboxedAppIframe(containerRef.current, {
      html,
      theme,
      height: spec.height,
      onHeight: setHeight,
      onError: setError,
    });
  }, [html, theme, spec.height]);
  return (
    <View style={{ width: "100%", gap: 4 }}>
      <View ref={containerRef} style={{ width: "100%", minHeight: height }} />
      {error !== null ? <ErrorLine message={error} /> : null}
    </View>
  );
}

/** Native fallback: plain views. Bar columns and pie rows read well; the rest fall back to value rows. */
function ChartNative({ spec }: { spec: ChartSpecInfo }) {
  const { theme } = useUiRuntime();
  const fmtVal = (v: number) => formatVal(v, spec.unit);
  return (
    <View style={{ gap: 10 }}>
      {spec.title !== null ? (
        <Text style={{ color: theme.colors.foreground, fontSize: 13.5, fontWeight: "600" }}>{spec.title}</Text>
      ) : null}
      {spec.series.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {spec.series.map((s, idx) => (
            <View key={s.name} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: toneColor(theme, s.tone),
                }}
              />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{s.name}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {spec.type === "bar" && spec.orientation === "vertical" ? (
        <ChartNativeColumns spec={spec} />
      ) : spec.type === "heatmap" ? (
        <ChartNativeHeatmap spec={spec} />
      ) : spec.type === "pie" ? (
        <ChartNativePie spec={spec} />
      ) : spec.type === "funnel" ? (
        <ChartNativeFunnel spec={spec} />
      ) : (
        <ChartNativeRows spec={spec} fmtVal={fmtVal} />
      )}
      {spec.xLabel !== null || spec.yLabel !== null ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
          {[
            spec.yLabel !== null ? `↕ ${spec.yLabel}` : "",
            spec.xLabel !== null ? `↔ ${spec.xLabel}` : "",
          ]
            .filter(Boolean)
            .join("  ·  ")}
        </Text>
      ) : null}
    </View>
  );
}

function ChartNativeColumns({ spec }: { spec: ChartSpecInfo }) {
  const { theme } = useUiRuntime();
  const boxH = 170;
  // Grouped columns and stacked columns are two shapes of one slot, never both.
  const stacked = spec.stacked && spec.series.length > 1;
  const totalAt = (i: number) => spec.series.reduce((sum, s) => sum + Math.max(0, s.values[i] ?? 0), 0);
  const extent = Math.max(
    1,
    ...(stacked
      ? spec.labels.map((_, i) => totalAt(i))
      : spec.series.flatMap((s) => s.values.map((v) => Math.max(0, v ?? 0)))),
  );
  const showValues = spec.showValues && spec.labels.length <= 12;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2 }}>
      {spec.labels.map((label, i) => (
        <View key={`${label}:${i}`} style={{ flex: 1, gap: 4, alignItems: "center" }}>
          {showValues ? (
            <Text
              numberOfLines={1}
              style={{ color: theme.colors.foregroundMuted, fontSize: 9, textAlign: "center" }}
            >
              {stacked
                ? formatVal(totalAt(i), spec.unit)
                : spec.series.map((s) => formatVal(s.values[i] ?? 0, spec.unit)).join(" / ")}
            </Text>
          ) : null}
          <View
            style={{
              height: boxH,
              width: "100%",
              flexDirection: "row",
              alignItems: "flex-end",
              justifyContent: "center",
              gap: 2,
            }}
          >
            {stacked ? (
              <View
                style={{
                  width: "62%",
                  height: Math.max(2, (totalAt(i) / extent) * boxH),
                  flexDirection: "column-reverse",
                  justifyContent: "flex-start",
                  borderTopLeftRadius: 3,
                  borderTopRightRadius: 3,
                  overflow: "hidden",
                }}
              >
                {spec.series.map((s, si) => {
                  const v = s.values[i] ?? 0;
                  if (v <= 0) return null;
                  return (
                    <View
                      key={si}
                      style={{ height: (v / extent) * boxH, backgroundColor: toneColor(theme, s.tone) }}
                    />
                  );
                })}
              </View>
            ) : (
              spec.series.map((s, si) => {
                const v = s.values[i] ?? 0;
                if (v <= 0) return null;
                return (
                  <View
                    key={si}
                    style={{
                      width: spec.series.length > 1 ? `${Math.round(74 / spec.series.length)}%` : "52%",
                      height: Math.max(2, (v / extent) * boxH),
                      backgroundColor: toneColor(theme, s.tone),
                      borderTopLeftRadius: 3,
                      borderTopRightRadius: 3,
                    }}
                  />
                );
              })
            )}
          </View>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 9.5, textAlign: "center" }}>
            {label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ChartNativePie({ spec }: { spec: ChartSpecInfo }) {
  const { theme } = useUiRuntime();
  const first = spec.series[0];
  if (!first) return <ErrorLine message="Chart series is empty" />;
  const slices = pieSlices(spec.labels, first.values, 8);
  const shares = percentages(slices.map((s) => s.value));
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", height: 14, borderRadius: 7, overflow: "hidden" }}>
        {slices.map((slice, i) => {
          const share = shares[i] ?? 0;
          return share > 0 ? (
            <View
              key={`${slice.label}:${i}`}
              style={{ width: `${share}%`, backgroundColor: toneColor(theme, wheelTone(i)) }}
            />
          ) : null;
        })}
      </View>
      {slices.map((slice, i) => (
        <View key={`${slice.label}:${i}:row`} style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneColor(theme, wheelTone(i)) }} />
            <Text style={{ color: theme.colors.foreground, fontSize: 12.5 }}>{slice.label}</Text>
          </View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {spec.showValues ? `${formatVal(slice.value, spec.unit)} (${shares[i] ?? 0}%)` : `${shares[i] ?? 0}%`}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ChartNativeFunnel({ spec }: { spec: ChartSpecInfo }) {
  const { theme } = useUiRuntime();
  const first = spec.series[0];
  if (!first) return <ErrorLine message="Chart series is empty" />;
  const stages = funnelStages(spec.labels, first.values);
  const barColor = toneColor(theme, first.tone);
  return (
    <View style={{ gap: 8 }}>
      {stages.map((stage, i) => (
        <View key={`${stage.label}:${i}`} style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 12.5 }}>{stage.label}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {[
                i > 0 && stage.ofFirst !== null ? formatShare(stage.ofFirst) : "",
                spec.showValues ? formatVal(stage.value, spec.unit) : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
          <View style={{ height: 12, borderRadius: 6, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
            <View
              style={{
                width: `${Math.max(2, Math.min(100, stage.width * 100))}%`,
                height: "100%",
                backgroundColor: barColor,
                opacity: 1 - (i / Math.max(1, stages.length - 1)) * 0.5,
                borderRadius: 6,
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

function ChartNativeHeatmap({ spec }: { spec: ChartSpecInfo }) {
  const { theme } = useUiRuntime();
  const labels = spec.labels;
  const allNums = spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const maxVal = Math.max(1, ...allNums);
  return (
    <ScrollView horizontal>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", gap: 4, paddingLeft: 80 }}>
          {labels.map((l, idx) => (
            <View key={idx} style={{ width: 54, alignItems: "center" }}>
              <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {l}
              </Text>
            </View>
          ))}
        </View>
        {spec.series.map((row, rIdx) => (
          <View key={`${row.name}:${rIdx}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text numberOfLines={1} style={{ width: 76, color: theme.colors.foregroundMuted, fontSize: 11.5 }}>
              {row.name}
            </Text>
            {labels.map((_, cIdx) => {
              const v = row.values[cIdx] ?? 0;
              const intensity = Math.max(0.12, Math.min(1, v / maxVal));
              return (
                <View
                  key={cIdx}
                  style={{
                    width: 54,
                    height: 28,
                    borderRadius: 4,
                    backgroundColor: theme.colors.surface2,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: v > 0 ? theme.colors.accent : theme.colors.border,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: v > 0 ? intensity : 0.4,
                  }}
                >
                  <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{formatNumber(v)}</Text>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function ChartNativeRows({ spec, fmtVal }: { spec: ChartSpecInfo; fmtVal: (v: number) => string }) {
  const { theme } = useUiRuntime();
  const allValues = spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const maxAbs = Math.max(1, ...allValues.map((v) => Math.abs(v)));
  return (
    <View style={{ gap: 8 }}>
      {spec.labels.map((label, lIdx) => (
        <View key={`${label}:${lIdx}`} style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 12.5 }}>{label}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {spec.series
                .map((s) => {
                  const v = s.values[lIdx];
                  return v === null || v === undefined ? "—" : fmtVal(v);
                })
                .join(" / ")}
            </Text>
          </View>
          <View style={{ gap: 3 }}>
            {spec.series.map((s, sIdx) => {
              const v = s.values[lIdx] ?? 0;
              const pct = Math.min(100, Math.max(2, Math.round((Math.abs(v) / maxAbs) * 100)));
              return (
                <View
                  key={sIdx}
                  style={{
                    height: spec.series.length > 1 ? 7 : 9,
                    borderRadius: 4,
                    backgroundColor: theme.colors.surface2,
                    overflow: "hidden",
                  }}
                >
                  <View
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      backgroundColor: toneColor(theme, s.tone),
                      borderRadius: 4,
                    }}
                  />
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

export function Sparkline({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const values = list(props.values)
    .map((v) => finiteNumber(v))
    .filter((v): v is number => v !== null);
  const t = tone(props.tone);
  const color = toneColor(theme, t === "neutral" ? "info" : t);
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 24 }}>
        {values.map((v, idx) => {
          const h = Math.max(3, Math.round(((v - min) / span) * 22));
          return (
            <View
              key={idx}
              style={{
                width: 4,
                height: h,
                borderRadius: 2,
                backgroundColor: color,
              }}
            />
          );
        })}
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>
        {formatNumber(values[values.length - 1]!)}
      </Text>
    </View>
  );
}

export function Progress({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const value = finiteNumber(props.value) ?? 0;
  const max = finiteNumber(props.max) ?? 100;
  const label = optionalText(props.label);
  const t = tone(props.tone);
  const pct = max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0;
  const color = toneColor(theme, t === "neutral" ? "info" : t);

  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {label ? <Text style={{ color: theme.colors.foreground, fontSize: 12.5 }}>{label}</Text> : <View />}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{pct}%</Text>
      </View>
      <View
        style={{
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.colors.surface2,
          overflow: "hidden",
        }}
      >
        <View style={{ width: `${pct}%`, height: "100%", backgroundColor: color, borderRadius: 4 }} />
      </View>
    </View>
  );
}

export function Gauge({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const value = finiteNumber(props.value) ?? 0;
  const min = finiteNumber(props.min) ?? 0;
  const max = finiteNumber(props.max) ?? 100;
  const label = optionalText(props.label);
  const t = tone(props.tone);
  const span = Math.max(1, max - min);
  const pct = Math.min(100, Math.max(0, Math.round(((value - min) / span) * 100)));
  const color = toneColor(theme, t === "neutral" ? "info" : t);

  return (
    <View
      style={{
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        padding: 12,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label ?? "Gauge"}</Text>
        <Text style={{ color, fontSize: 18, fontWeight: "700" }}>
          {formatNumber(value)} <Text style={{ fontSize: 11, fontWeight: "400" }}>/ {formatNumber(max)}</Text>
        </Text>
      </View>
      <View style={{ height: 10, borderRadius: 5, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>
        <View style={{ width: `${pct}%`, height: "100%", backgroundColor: color, borderRadius: 5 }} />
      </View>
    </View>
  );
}

export function SegmentedBar({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const unit = optionalText(props.unit) ?? "";
  const parts = list(props.parts).flatMap((p) => {
    const rec = asRecord(p);
    if (!rec) return [];
    const val = finiteNumber(rec.value);
    if (val === null || val <= 0) return [];
    return [{ label: text(rec.label), value: val, tone: tone(rec.tone) }];
  });
  const shares = percentages(parts.map((p) => p.value));
  const tones: Tone[] = ["info", "good", "warn", "bad", "neutral"];

  return (
    <View style={{ gap: 8 }}>
      <View
        style={{
          flexDirection: "row",
          height: 12,
          borderRadius: 6,
          overflow: "hidden",
          backgroundColor: theme.colors.surface2,
          gap: 2,
        }}
      >
        {parts.map((part, idx) => {
          const t = part.tone === "neutral" ? tones[idx % tones.length]! : part.tone;
          return (
            <View
              key={idx}
              style={{
                flex: Math.max(1, shares[idx] ?? 1),
                backgroundColor: toneColor(theme, t),
              }}
            />
          );
        })}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {parts.map((part, idx) => {
          const t = part.tone === "neutral" ? tones[idx % tones.length]! : part.tone;
          return (
            <View key={idx} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneColor(theme, t) }} />
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
                {part.label}:{" "}
                <Text style={{ color: theme.colors.foregroundMuted }}>
                  {formatNumber(part.value)}
                  {unit ? ` ${unit}` : ""} ({shares[idx] ?? 0}%)
                </Text>
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export function Steps({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const items = list(props.items);

  return (
    <View style={{ gap: 8 }}>
      {items.map((item, idx) => {
        const obj = asRecord(item) ?? { title: text(item) };
        const title = text(obj.title ?? obj.label);
        const detail = optionalText(obj.detail);
        const status = text(obj.status);
        const color =
          status === "done"
            ? theme.colors.statusSuccess
            : status === "blocked"
              ? theme.colors.statusDanger
              : status === "current"
                ? theme.colors.accent
                : theme.colors.foregroundMuted;
        return (
          <View key={idx} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 11,
                borderWidth: 1.5,
                borderColor: color,
                backgroundColor: theme.colors.surface2,
                alignItems: "center",
                justifyContent: "center",
                marginTop: 1,
              }}
            >
              <Text style={{ color, fontSize: 11, fontWeight: "700" }}>{idx + 1}</Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                {title}
              </Text>
              {detail ? (
                <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  <InlineMarkdown text={detail} theme={theme} />
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function Timeline({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const entries = timelineEntries(list(props.items));

  return (
    <View style={{ gap: 10 }}>
      {entries.map((entry, idx) => (
        <View key={idx} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: toneColor(theme, entry.tone),
              marginTop: 6,
            }}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
              <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>
                {entry.title}
              </Text>
              {entry.time ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>{entry.time}</Text>
              ) : null}
            </View>
            {entry.detail ? (
              <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                <InlineMarkdown text={entry.detail} theme={theme} />
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

export function Calendar({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const { events } = parseEvents(props.events);
  const requested = parseMonth(props.month);
  const today = useMemo(() => localToday(new Date()), []);
  const startMonth = useMemo(() => initialMonth(events, requested, today), [events, requested, today]);
  const [month, setMonth] = useState(startMonth);

  const weeks = useMemo(() => monthWeeks(month, 1), [month]);
  const byDay = useMemo(() => {
    const map = new Map<string, typeof events>();
    for (const ev of events) {
      map.set(ev.key, [...(map.get(ev.key) ?? []), ev]);
    }
    return map;
  }, [events]);

  return (
    <View
      style={{
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        padding: 12,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13.5, fontWeight: "600" }}>
          {monthKey(month)}
        </Text>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Pressable
            onPress={() => setMonth((m) => addMonths(m, -1))}
            style={{ padding: 4, borderRadius: 4, backgroundColor: theme.colors.surface1 }}
          >
            <Icon name="ChevronLeft" size={14} color={theme.colors.foreground} />
          </Pressable>
          <Pressable
            onPress={() => setMonth((m) => addMonths(m, 1))}
            style={{ padding: 4, borderRadius: 4, backgroundColor: theme.colors.surface1 }}
          >
            <Icon name="ChevronRight" size={14} color={theme.colors.foreground} />
          </Pressable>
        </View>
      </View>
      {weeks.map((week, wIdx) => (
        <View key={wIdx} style={{ flexDirection: "row", gap: 4 }}>
          {week.map((day, dIdx) => {
            const key = day === null ? "" : dayKey({ ...month, day });
            const dayEvents = key ? byDay.get(key) ?? [] : [];
            return (
              <View
                key={dIdx}
                style={{
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 6,
                  padding: 4,
                  backgroundColor: day === null ? "transparent" : theme.colors.surface1,
                  borderWidth: dayEvents.length > 0 ? 1 : StyleSheet.hairlineWidth,
                  borderColor: dayEvents.length > 0 ? theme.colors.accent : theme.colors.border,
                  gap: 2,
                }}
              >
                {day !== null ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10.5 }}>{day}</Text>
                ) : null}
                {dayEvents.slice(0, 2).map((ev, eIdx) => (
                  <Text
                    key={eIdx}
                    numberOfLines={1}
                    style={{ color: toneColor(theme, ev.tone), fontSize: 10, fontWeight: "500" }}
                  >
                    {ev.title}
                  </Text>
                ))}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export function CalendarHeatmap({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const { values } = useMemo(() => readDays(props.days), [props.days]);
  const label = optionalText(props.label);
  const stats = useMemo(() => calendarStats(values), [values]);
  const days = [...values.keys()].sort((a, b) => a - b);
  if (days.length === 0) return <ErrorLine message="CalendarHeatmap has no valid dates" />;
  const first = days[0]!;
  const last = Math.max(first + 28, days[days.length - 1]!);
  const layout = calendarLayout(first, last);
  const peakVal = stats.peak?.value ?? 1;

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12.5, fontWeight: "500" }}>
          {label ?? "Activity"}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>
          {formatNumber(stats.total)} total · {stats.active} active days
          {stats.peak ? ` · peak ${formatNumber(stats.peak.value)} (${dayLabel(stats.peak.day)})` : ""}
        </Text>
      </View>
      <ScrollView horizontal>
        <View style={{ flexDirection: "row", gap: 3 }}>
          {Array.from({ length: Math.min(53, layout.weeks) }, (_, w) => (
            <View key={w} style={{ gap: 3 }}>
              {Array.from({ length: 7 }, (__, d) => {
                const day = layout.start + w * 7 + d;
                const val = values.get(day) ?? 0;
                const active = val > 0;
                return (
                  <View
                    key={d}
                    style={{
                      width: 11,
                      height: 11,
                      borderRadius: 2,
                      backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
                      opacity: active ? Math.max(0.25, Math.min(1, val / peakVal)) : 0.4,
                    }}
                  />
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

export function Tree({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const roots = useMemo(() => buildTree(list(props.items)), [props.items]);
  const initialOpen = useMemo(() => [...defaultExpanded(roots)], [roots]);
  const [openIds, setOpenIds] = usePersistedState<string[]>(
    `tree:${propsKey(props.items)}`,
    initialOpen,
    (v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null),
  );
  const openSet = useMemo(() => new Set(openIds), [openIds]);
  const rows = useMemo(() => visibleRows(roots, (id) => openSet.has(id)), [roots, openSet]);

  return (
    <View
      style={{
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        paddingVertical: 6,
      }}
    >
      {rows.map(({ item, depth }) => {
        const isOpen = openSet.has(item.id);
        return (
          <Pressable
            key={item.id}
            onPress={() => {
              if (!item.folder) return;
              setOpenIds((prev) =>
                prev.includes(item.id) ? prev.filter((x) => x !== item.id) : [...prev, item.id],
              );
            }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingLeft: 10 + depth * 16,
              paddingRight: 10,
              paddingVertical: 5,
              gap: 8,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
              <Icon
                name={item.folder ? (isOpen ? "FolderOpen" : "Folder") : "FileText"}
                size={13}
                color={item.folder ? theme.colors.accent : theme.colors.foregroundMuted}
              />
              <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12 }}>
                {item.label}
              </Text>
            </View>
            {item.note !== null ? (
              isNode(item.note) ? (
                <RenderNode node={item.note} />
              ) : (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>
                  {text(item.note)}
                </Text>
              )
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const PROSE_LANGUAGES = new Set(["markdown", "md", "text", "txt"]);

export function Code({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const toast = useToast();
  const code = text(props.code);
  const language = optionalText(props.language);
  const wrap = language !== null && PROSE_LANGUAGES.has(language.toLowerCase());
  const codeText = (
    <Text
      selectable
      style={{
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 18,
      }}
    >
      {code}
    </Text>
  );

  return (
    <View
      style={{
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>
          {language ?? "code"}
        </Text>
        <Pressable
          onPress={() => {
            void copyText(code).then(
              () => toast.show("Copied", { variant: "success" }),
              () => toast.error("Could not copy"),
            );
          }}
        >
          <Icon name="Copy" size={13} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {wrap ? (
        <View style={{ padding: 10 }}>{codeText}</View>
      ) : (
        <ScrollView horizontal>
          <View style={{ padding: 10 }}>{codeText}</View>
        </ScrollView>
      )}
    </View>
  );
}

export function Snippet({ props }: { props: Props }) {
  const { theme, openFile } = useUiRuntime();
  const filePath = text(props.path);
  const from = finiteNumber(props.from) ?? 1;
  const code = text(props.code);
  const lines = code.split("\n");

  return (
    <View
      style={{
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
      }}
    >
      <Pressable
        onPress={() => {
          if (openFile) void openFile(filePath, Math.round(from));
        }}
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        }}
      >
        <Text style={{ color: theme.colors.accent, fontSize: 11.5, fontFamily: "monospace" }}>
          {filePath}:{Math.round(from)}
        </Text>
      </Pressable>
      <ScrollView horizontal>
        <View style={{ padding: 10, gap: 1 }}>
          {lines.map((line, idx) => (
            <View key={idx} style={{ flexDirection: "row", gap: 10 }}>
              <Text
                style={{
                  width: 34,
                  textAlign: "right",
                  color: theme.colors.foregroundMuted,
                  fontFamily: "monospace",
                  fontSize: 11.5,
                }}
              >
                {Math.round(from) + idx}
              </Text>
              <Text
                selectable
                style={{
                  color: theme.colors.foreground,
                  fontFamily: "monospace",
                  fontSize: 12,
                }}
              >
                {line}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

export function Diff({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const patch = text(props.patch);
  const lines = patch.split("\n");

  return (
    <View
      style={{
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
      }}
    >
      <ScrollView horizontal>
        <View style={{ paddingVertical: 8, minWidth: "100%" }}>
          {lines.map((line, idx) => {
            const added = line.startsWith("+") && !line.startsWith("+++");
            const removed = line.startsWith("-") && !line.startsWith("---");
            const hunk = line.startsWith("@@");
            const color = added
              ? theme.colors.statusSuccess
              : removed
                ? theme.colors.statusDanger
                : hunk
                  ? theme.colors.accent
                  : theme.colors.foreground;
            return (
              <View
                key={idx}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 1,
                }}
              >
                <Text
                  selectable
                  style={{
                    color,
                    fontFamily: "monospace",
                    fontSize: 12,
                    lineHeight: 17,
                  }}
                >
                  {line}
                </Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
