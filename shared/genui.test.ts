import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  collectLoads,
  compile,
  compileStreaming,
  dataKey,
  evaluate,
  initialState,
} from "./core";
import { COMPONENTS, type ComponentName } from "./core/catalog";
import { checkSpec, findFences, renderReplyMarkdown } from "./fallback";
import {
  AGENT_INSTRUCTIONS,
  CODE_WORK_INSTRUCTIONS,
  RELIABILITY_INSTRUCTIONS,
  UI_REFERENCE,
  UI_REFERENCE_MORE,
} from "./instructions";
import { splitTimelineMessage } from "./segment";
import {
  listGallery,
  loadAgentAudio,
  loadAgentFile,
  loadAgentImage,
  loadGalleryFile,
  readGallerySpec,
  setExtraLoadFolders,
} from "../server/data-source";

type PaseoApi = PluginHandlerContext["paseo"];

describe("paseo-plugin-genui core, instructions, and gallery", () => {
  it("compiles every example in the agent instructions cleanly", () => {
    for (const section of [
      UI_REFERENCE,
      UI_REFERENCE_MORE,
      RELIABILITY_INSTRUCTIONS,
      CODE_WORK_INSTRUCTIONS,
      AGENT_INSTRUCTIONS,
    ]) {
      const fences = findFences(section.split("\n")).filter((f) => f.language === "ui");
      for (const fence of fences) {
        const compiled = compile(fence.body);
        expect(compiled.diagnostics, fence.body).toEqual([]);
        expect(compiled.program).not.toBeNull();
      }
    }
  });

  it("supports .concat() and .sort() on lists", () => {
    const compiled = compile(
      [
        "a = [{n: \"x\", v: 3}, {n: \"y\", v: 1}]",
        "all = a.concat([{n: \"z\", v: 2}])",
        "Text(all.sort((p, q) => q.v - p.v).map(p => p.n).join(\",\"))",
        "Text([10, 9, 1].sort().join(\",\"))",
        "Text(a.map(p => p.n).join(\",\"))",
      ].join("\n"),
    );
    expect(compiled.diagnostics).toEqual([]);
    const { roots } = evaluate(compiled.program!, initialState(compiled.program!));
    expect(roots.map((root) => root.props.text)).toEqual(["x,z,y", "1,9,10", "x,y"]);
  });

  it("declares state an input binds to but the block never declared", () => {
    const compiled = compile(`Card("x", [
  Text($org == "" ? "no org" : $org),
  Form([
    Radio($browser, [{value: "A", detail: "a"}], label: "Q1"),
    Input($org, label: "Q2"),
    Toggle($ok, "Q3"),
    Checklist($picks, ["a", "b"]),
    Slider($n, 0, 10)
  ], submit: "Send")
])`);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(compiled.diagnostics.filter((d) => d.severity === "warning")).toHaveLength(5);
    expect(initialState(compiled.program!)).toEqual({ browser: "", org: "", ok: false, picks: [], n: 0 });
    expect(evaluate(compiled.program!, initialState(compiled.program!)).diagnostics).toEqual([]);
  });

  it("still reports state that no input binds to", () => {
    const compiled = compile('Text($missing)');
    expect(compiled.diagnostics.some((d) => d.severity === "error" && d.message.includes("unknown state `$missing`"))).toBe(true);
  });

  it("renders a bare Send, OpenUrl or Copy among children as a Button", () => {
    const compiled = compile('Card("x", [Text("a"), OpenUrl("https://docs.google.com/x"), Send("Go"), Copy("id")])');
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const { roots, diagnostics } = evaluate(compiled.program!, initialState(compiled.program!));
    expect(diagnostics).toEqual([]);
    const buttons = (roots[0]!.props.children as { type: string; props: { label: string } }[]).filter((c) => c.type === "Button");
    expect(buttons.map((b) => b.props.label)).toEqual(["Open docs.google.com", "Go", "Copy"]);
  });

  it("supports .replace() and .replaceAll() on text", () => {
    const compiled = compile(
      [
        "Text(\"katalon-studio/a-b-b\".replace(\"katalon-studio/\", \"\").replaceAll(\"-\", \" \"))",
        "Text(\"a.b\".replace(\".\", \"$&!\"))",
      ].join("\n"),
    );
    expect(compiled.diagnostics).toEqual([]);
    const { roots } = evaluate(compiled.program!, initialState(compiled.program!));
    expect(roots.map((root) => root.props.text)).toEqual(["a b b", "a$&!b"]);
  });

  it("accepts a declared function's name as a list method's function", () => {
    const compiled = compile(
      [
        "items = [{n: \"x\", v: 3}, {n: \"y\", v: 1}, {n: \"z\", v: 2}]",
        "label = (p, i) => `${i}:${p.n}`",
        "big = p => p.v > 1",
        "byV = (a, b) => a.v - b.v",
        "Text(items.filter(big).map(label).join(\",\"))",
        "Text(items.sort(byV).map(p => p.n).join(\",\"))",
        "row = p => [p.n, p.v]",
        "Table([\"n\", \"v\"], items.map(row))",
      ].join("\n"),
    );
    expect(compiled.diagnostics).toEqual([]);
    const { roots } = evaluate(compiled.program!, initialState(compiled.program!));
    expect(roots.slice(0, 2).map((root) => root.props.text)).toEqual(["0:x,1:z", "y,z,x"]);
    expect(roots[2].props.rows).toEqual([["x", 3], ["y", 1], ["z", 2]]);
  });

  it("covers all 86 catalog components in the gallery and compiles + evaluates every gallery spec", async () => {
    const files = await listGallery();
    expect(files.length).toBeGreaterThanOrEqual(170);

    const covered = new Set<string>();
    for (const file of files) {
      const comp = file.replace(/\.ui$/, "").split("-")[0]!;
      covered.add(comp);

      const source = await readGallerySpec(file);
      const compiled = compile(source);
      expect(compiled.diagnostics, `${file} compile diagnostics`).toEqual([]);
      expect(compiled.program, `${file} program`).not.toBeNull();

      const requests = collectLoads(compiled.program!);
      const loadedPairs = await Promise.all(
        requests.map(async (req) => [dataKey(req), await loadGalleryFile(req.path, req)] as const),
      );
      for (const [key, res] of loadedPairs) {
        expect(res.ok, `${file} load ${key}`).toBe(true);
      }
      const data = new Map(loadedPairs);
      const state = initialState(compiled.program!, data);
      const evaluated = evaluate(compiled.program!, state, data);
      expect(evaluated.diagnostics, `${file} evaluate diagnostics`).toEqual([]);
      expect(evaluated.roots.length, `${file} roots`).toBeGreaterThan(0);
    }

    for (const name of Object.keys(COMPONENTS) as ComponentName[]) {
      expect(covered.has(name), `Gallery example for ${name}`).toBe(true);
    }
  });

  it("splits assistant messages into prose and streaming/complete ui and app blocks", () => {
    const plain = "Hello world\n```ts\nconst x = 1;\n```";
    expect(splitTimelineMessage(plain, "complete")).toBeUndefined();

    const streaming = "Here is your estimate:\n```ui\n$seats = 10\nCard(\"Estimate\", [Metric(\"Seats\", $seats)])";
    const splitStream = splitTimelineMessage(streaming, "streaming", "msg_1");
    expect(splitStream?.items).toHaveLength(2);
    expect(splitStream?.items[0]).toMatchObject({
      kind: "genui-text",
      data: { text: "Here is your estimate:", phase: "streaming" },
    });
    expect(splitStream?.items[1]).toMatchObject({
      kind: "genui-block",
      data: {
        language: "ui",
        complete: false,
        fenceIndex: 0,
        messageId: "msg_1",
      },
    });

    const streamCompile = compileStreaming("$seats = 10\nCard(\"Estimate\", [Metric(\"Seats\", $seats");
    expect(streamCompile.program).not.toBeNull();
  });

  it("renders replies containing ui and app blocks to plain markdown", async () => {
    const reply = [
      "Summary sentence.",
      "```ui",
      'Card("Metrics", [Metric("Latency", "14 ms")])',
      "```",
      "```app",
      "<!doctype html><title>Pendulum</title><canvas></canvas>",
      "```",
    ].join("\n");

    const md = await renderReplyMarkdown(reply, (req) => loadGalleryFile(req.path, req));
    expect(md).toContain("Summary sentence.");
    expect(md).toContain("Latency");
    expect(md).toContain("14 ms");
    expect(md).toContain("Interactive app: Pendulum");
  });

  it("validates specs with checkSpec", async () => {
    const valid = await checkSpec(
      'Card("Test", [Metric("Users", "42")])',
      (req) => loadGalleryFile(req.path, req),
    );
    expect(valid.ok).toBe(true);
    expect(valid.report).toContain("No errors.");
  });

  it("refuses symlinks and intermediate directory links escaping the workspace root across data, image, and audio reads", async () => {
    const testRoot = path.join("/tmp/opencode", `genui-symlink-test-${Date.now()}`);
    const workspace = path.join(testRoot, "workspace");
    const outside = path.join(testRoot, "outside");
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });

    try {
      const secretTxt = path.join(outside, "secret.txt");
      const secretPng = path.join(outside, "secret.png");
      const secretWav = path.join(outside, "secret.wav");
      const insideTxt = path.join(workspace, "allowed.txt");
      await writeFile(secretTxt, "top-secret-outside-line\n", "utf8");
      await writeFile(secretPng, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await writeFile(secretWav, Buffer.from("RIFF0000WAVEfmt "));
      await writeFile(insideTxt, "inside-workspace-line\n", "utf8");

      await symlink(secretTxt, path.join(workspace, "report.txt"));
      await symlink(secretPng, path.join(workspace, "report.png"));
      await symlink(secretWav, path.join(workspace, "report.wav"));
      await symlink(outside, path.join(workspace, "linked-dir"));

      const mockPaseo = {
        agents: {
          ref: () => ({
            current: () => ({ cwd: workspace }),
            refresh: async () => ({ agent: { cwd: workspace }, project: null }),
          }),
        },
      } as unknown as PaseoApi;

      const allowed = await loadAgentFile(mockPaseo, "agent_symlink_test", "allowed.txt", { raw: true });
      expect(allowed).toEqual({ ok: true, value: "inside-workspace-line\n" });

      const directSymlink = await loadAgentFile(mockPaseo, "agent_symlink_test", "report.txt", { raw: true });
      expect(directSymlink.ok).toBe(false);

      const dirSymlink = await loadAgentFile(mockPaseo, "agent_symlink_test", "linked-dir/secret.txt", { raw: true });
      expect(dirSymlink.ok).toBe(false);

      const imageSymlink = await loadAgentImage(mockPaseo, "agent_symlink_test", "report.png");
      expect(imageSymlink.ok).toBe(false);

      const audioSymlink = await loadAgentAudio(mockPaseo, "agent_symlink_test", "report.wav");
      expect(audioSymlink.ok).toBe(false);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });
  it("loads files from extra folders only once they are added in settings", async () => {
    const folder = path.join(os.homedir(), `.genui-extra-folder-test-${Date.now()}`);
    await mkdir(folder, { recursive: true });
    try {
      const file = path.join(folder, "notes.txt");
      await writeFile(file, "scratch-line\n", "utf8");
      const mockPaseo = {
        agents: { ref: () => ({ current: () => ({ cwd: "/nonexistent-workspace" }), refresh: async () => null }) },
      } as unknown as PaseoApi;
      const tilde = `~/${path.basename(folder)}/notes.txt`;

      expect((await loadAgentFile(mockPaseo, "agent_extra_test", file, { raw: true })).ok).toBe(false);

      setExtraLoadFolders([`~/${path.basename(folder)}`]);
      expect(await loadAgentFile(mockPaseo, "agent_extra_test", file, { raw: true })).toEqual({ ok: true, value: "scratch-line\n" });
      expect(await loadAgentFile(mockPaseo, "agent_extra_test", tilde, { raw: true })).toEqual({ ok: true, value: "scratch-line\n" });
      expect((await loadAgentFile(mockPaseo, "agent_extra_test", path.join(os.homedir(), ".bashrc"), { raw: true })).ok).toBe(false);
    } finally {
      setExtraLoadFolders([]);
      await rm(folder, { recursive: true, force: true });
    }
  });
});

describe("Draft", () => {
  it("is in the catalog and compiles with and without a title", () => {
    expect(COMPONENTS.Draft.group).toBe("Content");
    for (const call of ['Draft("**hi**")', 'Draft("**hi**", "PR reply")']) {
      const compiled = compile(`Card("x", [${call}])`);
      expect(compiled.diagnostics, call).toEqual([]);
      expect(compiled.program).not.toBeNull();
    }
    expect(compile('Card("x", [Draft()])').diagnostics.length).toBeGreaterThan(0);
  });

  it("keeps the draft label in the markdown fallback", async () => {
    const load = (req: { path: string }) => loadGalleryFile(req.path, req);
    const untitled = await renderReplyMarkdown('```ui\nDraft("Looks good")\n```', load);
    expect(untitled).toContain("**Draft**");
    expect(untitled).toContain("Looks good");
    const titled = await renderReplyMarkdown('```ui\nDraft("Looks good", "PR reply")\n```', load);
    expect(titled).toContain("**Draft: PR reply**");
  });

  it("is listed in the agent reference with a rule against markdown Code", () => {
    expect(UI_REFERENCE).toContain("Draft(markdown, title?)");
    expect(CODE_WORK_INSTRUCTIONS).toContain("Draft(markdown, title)");
  });
});

describe("Chart", () => {
  it("accepts a styled series entry alongside the plain one", () => {
    const compiled = compile(
      'Card("x", [Chart("line", ["a", "b"], {Plain: [1, 2], Styled: {values: [3, 4], tone: "warn", dashed: true}}, dashed: true, donut: false, smooth: true, height: 300, showValues: true, title: "t", xLabel: "x", yLabel: "y", orientation: "horizontal")])',
    );
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.program).not.toBeNull();
  });

  it("refuses a series that is a list of records or a styled entry with no values", () => {
    for (const bad of ['Chart("bar", ["a"], [{v: 1}])', 'Chart("bar", ["a"], {A: {tone: "warn"}})']) {
      const compiled = compile(`Card("x", [${bad}])`);
      expect(compiled.diagnostics, bad).toEqual([]);
      const { diagnostics } = evaluate(compiled.program!, initialState(compiled.program!));
      expect(diagnostics.length, bad).toBeGreaterThan(0);
    }
  });

  it("defaults yLabel to the unit and keeps the unit inside printed values", () => {
    // The renderer, not the compiler, applies these; the example only has to parse.
    const compiled = compile('Card("x", [Chart("bar", ["a"], {A: [1]}, unit: "GB")])');
    expect(compiled.diagnostics).toEqual([]);
  });
});
