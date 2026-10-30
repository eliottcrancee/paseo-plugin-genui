# Generative UI for Paseo

**Agents answer with charts, diagrams, maps, plans, and forms rendered inline in the Paseo chat timeline.**

![Inline Map, Calendar, and Budget UI in Paseo chat](assets/screenshot-chat.png)

![Gen-UI Gallery with 86 components and 179 live examples](assets/screenshot-gallery.png)

![Interactive Playground in Paseo](assets/screenshot-playground.png)

Ported from [ComicBit/bb-plugin-genui](https://github.com/ComicBit/bb-plugin-genui) (Apache-2.0) to Paseo's native timeline transformer, React Native surface, and daemon RPC architecture.

## Install

This repository is a fork of [anh-chu/paseo-plugin-genui](https://github.com/anh-chu/paseo-plugin-genui)
whose chart renderer is reworked (see [Charts](#charts)). Install from here, not from npm, until those
changes land upstream:

```bash
paseo plugin add git:eliottcrancee/paseo-plugin-genui
```

Or from a clone with `paseo plugin install .`.

Requires Paseo 0.13.0 or later.

## What an answer looks like

The agent writes a ```ui block in its reply:

~~~
```ui
$seats = 12
$plan = "Pro"
price = $plan == "Pro" ? 29 : 12
Card("Estimate", [
  Row([Choice($plan, ["Basic", "Pro"]), Slider($seats, 1, 50, label: "Seats")]),
  Metric("Total", "$" + fmt(price * $seats)),
  Button("Go with " + $plan, Send("Go with " + $plan), variant: "primary")
])
```
~~~

Paseo renders a card with a plan switch, a seat slider, and a live total. Moving the slider recomputes the total in place without another model call. Clicking the button sends your choice back to the agent.

## Components (86 across 10 groups)

| Group | Components |
| --- | --- |
| **Layout** | `Card` · `Row` · `Stack` · `Grid` · `Tabs` · `Details` · `Divider` · `Carousel` |
| **Content** | `Text` · `Callout` · `Draft` · `Metric` · `Badge` · `Icon` · `KeyValue` · `Image` · `File` · `Entity` · `Sources` · `List` |
| **Data** | `Table` · `Chart` (bar, line, area, pie, scatter, radar, funnel, heatmap) · `Sparkline` · `Progress` · `Gauge` · `SegmentedBar` · `Steps` · `Timeline` · `Calendar` · `CalendarHeatmap` · `Tree` · `Code` · `Snippet` · `Diff` · `Diagram` |
| **Media** | `ImageSearch` · `Gallery` · `Map` · `Hotspots` |
| **Inputs** | `Slider` · `Stepper` · `Toggle` · `Choice` · `Radio` · `Select` · `Checklist` · `ListEditor` · `Input` · `TextArea` · `DateInput` · `Rating` · `OptionCards` · `Swatches` · `EditableTable` · `Button` · `Form` · `FollowUps` |
| **Widgets** | `Timer` · `Quiz` · `Flashcards` · `Walkthrough` |
| **Project** | `Changes` · `Commits` · `PullRequest` · `Threads` · `Tests` · `Json` |
| **Dev** | `Logs` · `StackTrace` · `Findings` · `Coverage` · `Dependencies` · `Pipeline` · `Benchmark` · `Waterfall` · `Treemap` |
| **Manage** | `Board` · `Roadmap` · `Status` · `Plan` · `Decision` · `Estimate` · `Environments` |
| **Evidence** | `Acceptance` · `Compare` · `Transcript` · `Provenance` |

### Charts

`Chart` draws a real chart with axes, gridlines, ticks and legends on web and desktop: an SVG document inside the same sandboxed, theme-injecting iframe that runs `app` blocks, so it follows the light and dark theme and is interactive while the reply streams. Every option is a named argument, and the data stays the plain series form:

```ui
Chart("area", ["8h", "10h", "12h"], {
  P50: [120, 98, 74],
  P95: {values: [240, 210, 180], tone: "warn", dashed: true}
}, unit: "ms", smooth: true, yLabel: "Latency", title: "Latency by hour", height: 240)
```

The eight types are `bar`, `line`, `area`, `pie`, `scatter`, `radar`, `funnel` and `heatmap`. Options: `stacked` (bar and area), `dashed` (all series; a series' own `dashed` wins), `orientation: "horizontal"` (bar), `donut` (pie), `smooth` (line and area), `showValues` (numbers on the marks, on by default for pie, funnel and heatmap), `height` in pixels (150–560), `title`, `xLabel` and `yLabel` (which defaults to `unit`). Colors come from your theme; there is no palette to configure. On mobile, where the sandboxed iframe is unavailable, the same chart falls back to plain bars, funnels and value rows.

## Slash commands & surfaces

- `/genui [prompt]` — Teach an existing agent the Generative UI component language.
- `/genui-demo [ComponentName]` — Insert a live interactive Gen-UI block into the current chat (e.g. `/genui-demo Decision` or `/genui-demo Map`).
- `/genui-gallery` — Open the **Gen-UI Gallery** screen (179 examples across all 86 components, plus a live spec Playground).

## Develop

```bash
npm install
npm run typecheck && npm test
paseo plugin install .
paseo plugin reload genui
```

## License

[Apache-2.0](LICENSE). Original DSL, component catalog, and gallery examples by [ComicBit](https://github.com/ComicBit/bb-plugin-genui), ported to Paseo by [anh-chu](https://github.com/anh-chu/paseo-plugin-genui). Excalifont is under the SIL Open Font License (`assets/fonts/Excalifont-OFL.txt`).
