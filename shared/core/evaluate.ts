import type { ArrowExpr, CallExpr, Expr, Program } from "./ast";
import { FORBIDDEN_PROPERTIES, LIMITS, type ComponentName, type ComponentSpec, type ParamSpec } from "./catalog";
import { DiagnosticList, type Pos } from "./diagnostics";
import { dataKey, languageOf, snippetLines, snippetRangeError, type LoadedData } from "./data";
import type { Action, Binding, Diagnostic, UiNode, UiState, Value } from "./types";
import {
  ACTION_SPECS,
  COMPONENT_SPECS,
  coerceState,
  DESCRIPTIONS,
  EXPECTED,
  functionArg,
  LAMBDA_METHODS,
  stateMismatch,
  type Kind,
} from "./validate";
import { defineClass } from "./define-class";

/** Longest string any operation may produce; repeated doubling would otherwise exhaust memory. */
const MAX_STRING_LENGTH = 100_000;
/** Deepest expression nesting during evaluation (named values included), so the stack cannot overflow. */
const MAX_EVAL_DEPTH = 1_000;
/** Data for callers that load no files: every `Load` reports it is still loading, every `Snippet` shows its loading state. */
const NO_DATA: ReadonlyMap<string, LoadedData> = new Map();

interface EvalFailureFields extends Error {
  pos: Pos;
}

const EvalFailure = defineClass(
  function (this: EvalFailureFields, pos: Pos, message: string): void {
    this.pos = pos;
    this.message = message;
  },
  undefined,
  Error,
);
type EvalFailure = InstanceType<typeof EvalFailure>;

/** A problem local to one component: it becomes an Error node, siblings still render. */
const RuntimeError = defineClass(
  function (this: EvalFailureFields, pos: Pos, message: string): void {
    this.pos = pos;
    this.message = message;
  },
  undefined,
  EvalFailure,
);
type RuntimeError = InstanceType<typeof RuntimeError>;

/** A resource limit: evaluation stops. */
const LimitError = defineClass(
  function (this: EvalFailureFields, pos: Pos, message: string): void {
    this.pos = pos;
    this.message = message;
  },
  undefined,
  EvalFailure,
);
type LimitError = InstanceType<typeof LimitError>;

/**
 * A `Load` whose file is still being read. It travels like a RuntimeError, so
 * whatever used the value waits too, but the component becomes a Loading
 * placeholder instead of an Error, and it is no diagnostic.
 */
const LoadPending = defineClass(
  function (this: EvalFailureFields & { path: string }, pos: Pos, path: string): void {
    this.pos = pos;
    this.message = `Loading ${path}…`;
    this.path = path;
  },
  undefined,
  RuntimeError,
);
type LoadPending = InstanceType<typeof LoadPending>;

function kindOf(value: Value): Kind {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "list";
  // Object literals cannot carry these `kind` values (see the "object" case), so they mark interpreter output.
  if ("kind" in value && (value.kind === "node" || value.kind === "action" || value.kind === "binding")) {
    return value.kind;
  }
  return "object";
}

function describe(value: Value): string {
  return DESCRIPTIONS[kindOf(value)];
}

function isList(value: Value): value is readonly Value[] {
  return Array.isArray(value);
}

type PlainObject = { readonly [key: string]: Value };

/** A spec-language or loaded-data object, as opposed to interpreter-made nodes, actions and bindings. */
export function isPlainObject(value: Value): value is PlainObject {
  return kindOf(value) === "object";
}

function isNode(value: Value): value is UiNode {
  return kindOf(value) === "node";
}

function isAction(value: Value): value is Action {
  return kindOf(value) === "action";
}

function truthy(value: Value): boolean {
  return value !== null && value !== false && value !== 0 && value !== "";
}

/** Non-finite arithmetic results become null. */
function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function checkString(text: string, pos: Pos): string {
  if (text.length > MAX_STRING_LENGTH) {
    throw new RuntimeError(pos, `text longer than ${MAX_STRING_LENGTH} characters`);
  }
  return text;
}

function checkLength<T extends readonly Value[]>(list: T, pos: Pos): T {
  if (list.length > LIMITS.listLength) {
    throw new RuntimeError(pos, `lists are limited to ${LIMITS.listLength} items (got ${list.length})`);
  }
  return list;
}

/** Text for `+`, templates and `join`: null is empty, other scalars use String(). */
function toText(value: Value, pos: Pos): string {
  if (value === null) return "";
  if (typeof value === "object") {
    throw new RuntimeError(pos, `cannot turn ${describe(value)} into text${isList(value) ? '; use .join(", ")' : ""}`);
  }
  return String(value);
}

function compare(op: string, left: number | string, right: number | string): boolean {
  switch (op) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    default:
      return left >= right;
  }
}

/** Rounds half away from zero, exact for decimal inputs like 1.005. */
function roundTo(value: number, digits: number): number {
  const magnitude = Math.abs(value);
  let rounded = Number(`${Math.round(Number(`${magnitude}e${digits}`))}e${-digits}`);
  if (!Number.isFinite(rounded)) rounded = Math.round(magnitude * 10 ** digits) / 10 ** digits;
  return value < 0 ? -rounded : rounded;
}

/** `1234.5` → "1,234.5"; fixed `digits`, or up to `most` with trailing zeros trimmed. */
function fmt(value: number, digits: number | undefined, most = 2): string {
  let fixed = roundTo(value, digits ?? most).toFixed(digits ?? most);
  if (digits === undefined) fixed = fixed.replace(/\.0+$|(\.\d*?)0+$/, "$1");
  const [whole, fraction] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** `list[index]`, counting from the end for a negative index, as `.at()` does. */
function at(list: readonly Value[] | string, index: number): Value {
  const from = Math.trunc(index) < 0 ? list.length + Math.trunc(index) : Math.trunc(index);
  return from >= 0 && from < list.length ? list[from] : null;
}

function typeOf(value: Value): string {
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return typeof value;
  return "object";
}

/** The expression passed for `params[index]`, positionally or by name. */
function argument(call: CallExpr, params: readonly ParamSpec[], index: number): Expr | undefined {
  return index < call.args.length ? call.args[index] : call.named.find((arg) => arg.name === params[index].name)?.value;
}

interface Scope {
  readonly name: string;
  readonly value: Value;
  readonly parent: Scope | null;
}

interface InterpreterFields {
  diagnostics: DiagnosticList;
  steps: number;
  nodes: number;
  depth: number;
  suffix: string;
  cache: Map<string, { readonly value: Value } | { readonly error: RuntimeError }>;
  program: Program;
  state: UiState;
  data: ReadonlyMap<string, LoadedData>;
}

const Interpreter = defineClass(
  function (this: InterpreterFields, program: Program, state: UiState, data: ReadonlyMap<string, LoadedData>): void {
    this.program = program;
    this.state = state;
    this.data = data;
    this.diagnostics = new DiagnosticList();
    this.steps = 0;
    this.nodes = 0;
    this.depth = 0;
    this.suffix = "";
    this.cache = new Map<string, { readonly value: Value } | { readonly error: RuntimeError }>();
  },
  {
    /** Reports a failure (a load still in flight is none) and restores the evaluation context saved before it; rethrows anything else. */
    recover(error: unknown, depth: number, suffix: string): EvalFailure {
      if (!(error instanceof EvalFailure)) throw error;
      this.depth = depth;
      this.suffix = suffix;
      if (!(error instanceof LoadPending)) this.diagnostics.report(error.pos, error.message);
      return error;
    },

    expr(expr: Expr, scope: Scope | null): Value {
      if (++this.steps > LIMITS.steps) {
        throw new LimitError(expr.pos, `the UI needs more than ${LIMITS.steps} evaluation steps; simplify it`);
      }
      if (++this.depth > MAX_EVAL_DEPTH) throw new LimitError(expr.pos, "expressions are nested too deeply");
      const value = this.compute(expr, scope);
      this.depth--;
      return value;
    },

    compute(expr: Expr, scope: Scope | null): Value {
      switch (expr.type) {
        case "literal":
          return expr.value;
        case "template": {
          let text = expr.quasis[0];
          expr.parts.forEach((part, index) => {
            text += toText(this.expr(part, scope), part.pos) + expr.quasis[index + 1];
          });
          return checkString(text, expr.pos);
        }
        case "state":
          return Object.hasOwn(this.state, expr.name) ? this.state[expr.name] : null;
        case "ident":
          for (let current = scope; current !== null; current = current.parent) {
            if (current.name === expr.name) return current.value;
          }
          return this.named(expr.name, expr.pos);
        case "list":
          return checkLength(this.spread(expr.items, scope).values, expr.pos);
        case "object": {
          const object: Record<string, Value> = {};
          for (const entry of expr.entries) {
            const value = this.expr(entry.value, scope);
            if (entry.key === null) {
              if (value === null) continue;
              if (!isPlainObject(value)) throw new RuntimeError(entry.pos, `\`...\` in an object needs an object, got ${describe(value)}`);
              // Copy own keys one by one: Object.assign would run the `__proto__` setter for loaded JSON's own `__proto__` key.
              for (const [key, item] of Object.entries(value)) {
                if (!(FORBIDDEN_PROPERTIES as readonly string[]).includes(key)) object[key] = item;
              }
              continue;
            }
            const key = typeof entry.key === "string" ? entry.key : toText(this.expr(entry.key, scope), entry.key.pos);
            if ((FORBIDDEN_PROPERTIES as readonly string[]).includes(key)) throw new RuntimeError(entry.pos, `\`${key}\` is not accessible`);
            if (key === "kind" && (value === "node" || value === "action" || value === "binding")) {
              throw new RuntimeError(entry.pos, `\`kind: "${value}"\` is reserved; use another key or value`);
            }
            object[key] = value;
          }
          return object;
        }
        case "spread":
          throw new RuntimeError(expr.pos, "`...` works only inside [ ], { } and function arguments");
        case "let":
          return this.expr(expr.body, { name: expr.name, value: this.expr(expr.value, scope), parent: scope });
        case "unary": {
          const operand = this.expr(expr.operand, scope);
          if (expr.op === "typeof") return typeOf(operand);
          return expr.op === "!" ? !truthy(operand) : finite(-this.number(operand, expr.pos, "`-`"));
        }
        case "binary":
          return this.binary(expr, scope);
        case "conditional":
          return truthy(this.expr(expr.test, scope)) ? this.expr(expr.then, scope) : this.expr(expr.else, scope);
        case "member":
          return this.member(this.expr(expr.object, scope), expr.name, expr.pos);
        case "index":
          return this.index(this.expr(expr.object, scope), this.expr(expr.index, scope), expr.pos);
        case "call": {
          const component = COMPONENT_SPECS.get(expr.name);
          if (component !== undefined) return this.component(expr, component, scope);
          const action = ACTION_SPECS.get(expr.name);
          if (action !== undefined) return this.action(expr, action, scope);
          const own = this.program.named.get(expr.name)?.value;
          if (own?.type === "arrow") return this.callOwn(expr, own, scope);
          return this.callFunction(expr, scope);
        }
        case "method":
          return this.method(expr, scope);
        case "arrow":
          throw new RuntimeError(
            expr.pos,
            "arrow functions can only be declared as a named function (`share = p => ...`) or passed to map, filter, find, some, every or sort",
          );
      }
    },

    named(name: string, pos: Pos): Value {
      const cached = this.cache.get(name);
      if (cached !== undefined) {
        if ("error" in cached) throw cached.error;
        return cached.value;
      }
      const decl = this.program.named.get(name);
      if (decl === undefined) throw new RuntimeError(pos, `\`${name}\` is not defined`);
      if (decl.value.type === "arrow") throw new RuntimeError(pos, `\`${name}\` is a function; call it, as in \`${name}(...)\``);
      // Named values are top-level: their nodes never take the keys of the map that reads them.
      const suffix = this.suffix;
      this.suffix = "";
      try {
        const value = this.expr(decl.value, null);
        this.cache.set(name, { value });
        this.suffix = suffix;
        return value;
      } catch (error) {
        if (error instanceof RuntimeError) this.cache.set(name, { error });
        throw error;
      }
    },

    number(value: Value, pos: Pos, label: string): number {
      if (typeof value !== "number") throw new RuntimeError(pos, `${label} needs a number, got ${describe(value)}`);
      return value;
    },

    text(value: Value, pos: Pos, label: string): string {
      if (typeof value !== "string") throw new RuntimeError(pos, `${label} needs text, got ${describe(value)}`);
      return value;
    },

    digits(value: Value, pos: Pos, label: string): number {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 20) {
        throw new RuntimeError(pos, `${label} digits must be a whole number from 0 to 20`);
      }
      return value;
    },

    binary(expr: Extract<Expr, { type: "binary" }>, scope: Scope | null): Value {
      const op = expr.op;
      const left = this.expr(expr.left, scope);
      if (op === "&&") return truthy(left) ? this.expr(expr.right, scope) : left;
      if (op === "||") return truthy(left) ? left : this.expr(expr.right, scope);
      if (op === "??") return left === null ? this.expr(expr.right, scope) : left;
      const right = this.expr(expr.right, scope);
      switch (op) {
        case "==":
        case "===":
          return left === right;
        case "!=":
        case "!==":
          return left !== right;
        case "+":
          if (typeof left === "string" || typeof right === "string") {
            return checkString(toText(left, expr.left.pos) + toText(right, expr.right.pos), expr.pos);
          }
          if (typeof left === "number" && typeof right === "number") return finite(left + right);
          throw new RuntimeError(expr.pos, `\`+\` needs numbers or text, got ${describe(left)} and ${describe(right)}`);
        case "in":
          if (isList(right)) return typeof left === "number" && Number.isInteger(left) && left >= 0 && left < right.length;
          if (isPlainObject(right)) return Object.hasOwn(right, this.text(left, expr.left.pos, "`in`"));
          throw new RuntimeError(expr.pos, `\`in\` needs an object or a list on its right, got ${describe(right)}`);
        case "<":
        case "<=":
        case ">":
        case ">=":
          if (typeof left === "number" && typeof right === "number") return compare(op, left, right);
          if (typeof left === "string" && typeof right === "string") return compare(op, left, right);
          throw new RuntimeError(expr.pos, `\`${op}\` compares two numbers or two texts, got ${describe(left)} and ${describe(right)}`);
      }
      const a = this.number(left, expr.left.pos, `\`${op}\``);
      const b = this.number(right, expr.right.pos, `\`${op}\``);
      switch (op) {
        case "-":
          return finite(a - b);
        case "*":
          return finite(a * b);
        case "/":
          return finite(a / b);
        case "%":
          return finite(a % b);
        case "**":
          return finite(a ** b);
      }
    },

    member(object: Value, name: string, pos: Pos): Value {
      if (object === null) return null;
      if (isPlainObject(object)) {
        // Narrowing keeps structurally compatible Action shapes; widen to read by key.
        const record: PlainObject = object;
        return Object.hasOwn(record, name) ? record[name] : null;
      }
      if (isList(object) || typeof object === "string") {
        if (name === "length") return object.length;
        throw new RuntimeError(pos, `${describe(object)} only has \`.length\`; \`.${name}\` does not exist`);
      }
      throw new RuntimeError(pos, `cannot read \`.${name}\` of ${describe(object)}`);
    },

    index(object: Value, index: Value, pos: Pos): Value {
      if (object === null) return null;
      if (isList(object) || typeof object === "string") {
        const at = this.number(index, pos, "an index");
        return Number.isInteger(at) && at >= 0 && at < object.length ? object[at] : null;
      }
      if (isPlainObject(object)) {
        const record: PlainObject = object;
        const key = this.text(index, pos, "an object key");
        if ((FORBIDDEN_PROPERTIES as readonly string[]).includes(key)) {
          throw new RuntimeError(pos, `\`${key}\` is not accessible`);
        }
        return Object.hasOwn(record, key) ? record[key] : null;
      }
      throw new RuntimeError(pos, `cannot index ${describe(object)}`);
    },

    node(type: UiNode["type"], key: string, props: Record<string, Value>, pos: Pos): UiNode {
      if (++this.nodes > LIMITS.nodes) throw new LimitError(pos, `the UI has more than ${LIMITS.nodes} components`);
      return { kind: "node", type, key, props };
    },

    component(call: CallExpr, spec: ComponentSpec, scope: Scope | null): UiNode {
      const key = `${call.pos.line}:${call.pos.column}${this.suffix}`;
      // COMPONENT_SPECS only holds catalog names.
      const type = call.name as ComponentName;
      const depth = this.depth;
      const suffix = this.suffix;
      try {
        const props: Record<string, Value> = {};
        spec.params.forEach((param, index) => {
          const arg = argument(call, spec.params, index);
          if (arg === undefined) return;
          const value = this.param(param, arg, scope, `${call.name} ${param.name}`, key);
          if (value !== undefined) props[param.name] = value;
        });
        return this.node(type, key, type === "Snippet" ? this.snippet(props) : props, call.pos);
      } catch (error) {
        if (!(error instanceof RuntimeError)) throw error;
        const failure = this.recover(error, depth, suffix);
        return failure instanceof LoadPending
          ? this.node("Loading", key, { path: failure.path, component: type }, call.pos)
          : this.node("Error", key, { message: failure.message }, call.pos);
      }
    },

    /**
     * Snippet props: the requested range plus its lines from the raw file. A file
     * still loading is `code: null` (the renderer shows a placeholder), and a
     * file or range problem is `error`, never an Error node.
     */
    snippet(props: Readonly<Record<string, Value>>): Record<string, Value> {
      // `path` is a required string param and the others optional numbers, so these are the evaluated values.
      const path = typeof props.path === "string" ? props.path : "";
      const from = typeof props.from === "number" ? props.from : null;
      const to = typeof props.to === "number" ? props.to : null;
      const loaded = this.data.get(dataKey({ path, raw: true }));
      const rangeError = snippetRangeError(from, to);
      let shown: { code: string | null; error: string | null };
      if (rangeError !== null) shown = { code: null, error: rangeError };
      else if (loaded === undefined) shown = { code: null, error: null };
      else if (!loaded.ok) shown = { code: null, error: loaded.error };
      else if (typeof loaded.value !== "string") shown = { code: null, error: "not a text file" };
      else shown = snippetLines(loaded.value, from, to);
      return { path, from, to, code: shown.code, error: shown.error, language: languageOf(path) };
    },

    /** Evaluates and normalizes one argument; `undefined` means an optional param passed as null. */
    param(param: ParamSpec, arg: Expr, scope: Scope | null, label: string, key: string): Value | undefined {
      if (param.kind === "binding") {
        if (arg.type !== "state") throw new RuntimeError(arg.pos, `${label} must be a state variable written as \`$name\``);
        const value = Object.hasOwn(this.state, arg.name) ? this.state[arg.name] : null;
        // Set() or a computed initial value can still give the state the wrong
        // type; a lossless reading keeps the input working, anything else fails.
        const mismatch = stateMismatch(label, param, arg.name, kindOf(value), "holds");
        const coerced = mismatch === null ? value : coerceState(param.holds, value);
        if (coerced === undefined) throw new RuntimeError(arg.pos, mismatch!);
        const binding: Binding = { kind: "binding", name: arg.name, value: coerced };
        return binding;
      }
      const value = this.expr(arg, scope);
      if (param.kind === "nodes") return this.children(value, arg.pos, label, key);
      if (param.kind === "actions") return this.actions(value, arg.pos, label);
      if (value === null) {
        if (param.optional) return undefined;
        if (param.nullable || param.kind === "any") return null;
      }
      switch (param.kind) {
        case "string":
        case "text":
          if (value !== null && typeof value !== "object") return String(value);
          break;
        case "number":
          if (typeof value === "number") return value;
          break;
        case "boolean":
          if (typeof value === "boolean") return value;
          break;
        case "enum": {
          const values = param.values ?? [];
          if (typeof value === "string" && values.includes(value)) return value;
          const got = typeof value === "string" ? JSON.stringify(value) : describe(value);
          throw new RuntimeError(arg.pos, `${label} must be one of ${values.join(", ")}; got ${got}`);
        }
        case "list":
          if (isList(value)) return value;
          break;
        case "series": {
          const isNumbers = (item: Value) => isList(item) && item.every((n) => typeof n === "number" || n === null);
          // {name: [numbers]} and the styled form {name: {values, tone?, dashed?}} both read.
          const isEntry = (item: Value): boolean => {
            if (!isPlainObject(item)) return false;
            const entry: PlainObject = item;
            return (
              isNumbers(entry.values) &&
              (entry.tone === undefined || typeof entry.tone === "string") &&
              (entry.dashed === undefined || typeof entry.dashed === "boolean")
            );
          };
          if (
            isNumbers(value) ||
            (isPlainObject(value) && Object.values(value).every((item) => isNumbers(item) || isEntry(item)))
          ) {
            return value;
          }
          break;
        }
        case "any":
          return value;
      }
      throw new RuntimeError(arg.pos, `${label} needs ${EXPECTED[param.kind]}, got ${describe(value)}`);
    },

    /** Flattens children: strings/numbers become Text nodes, null/false are dropped. */
    children(value: Value, pos: Pos, label: string, key: string): UiNode[] {
      const out: UiNode[] = [];
      const visit = (item: Value): void => {
        if (item === null || item === false) return;
        if (typeof item === "string" || typeof item === "number") {
          out.push(this.node("Text", `${key}.${out.length}`, { text: String(item) }, pos));
        } else if (isList(item)) {
          for (const child of item) visit(child);
        } else if (isNode(item)) {
          out.push(item);
        } else if (isAction(item) && item.type !== "set") {
          // A bare action where a component belongs: render it as the Button the agent meant.
          const text = item.type === "openUrl" ? `Open ${new URL(item.url).host}` : item.type === "copy" ? "Copy" : item.text;
          out.push(this.node("Button", `${key}.${out.length}`, { label: text, action: [item], variant: null, icon: null }, pos));
        } else {
          throw new RuntimeError(pos, `${label} must be components or text, got ${describe(item)}`);
        }
      };
      visit(value);
      return out;
    },

    actions(value: Value, pos: Pos, label: string): Action[] {
      const out: Action[] = [];
      const visit = (item: Value): void => {
        if (item === null || item === false) return;
        if (isList(item)) {
          for (const child of item) visit(child);
        } else if (isAction(item)) {
          out.push(item);
        } else {
          throw new RuntimeError(pos, `${label} takes actions such as Send("..."), got ${describe(item)}`);
        }
      };
      visit(value);
      return out;
    },

    action(call: CallExpr, spec: ComponentSpec, scope: Scope | null): Action {
      // Every action has a required first param; the validator guarantees it is present.
      const first = argument(call, spec.params, 0)!;
      if (call.name === "Set") {
        if (first.type !== "state") throw new RuntimeError(first.pos, "Set needs a state variable written as `$name`");
        const second = argument(call, spec.params, 1)!;
        return { kind: "action", type: "set", name: first.name, value: this.expr(second, scope) };
      }
      const value = this.expr(first, scope);
      if (value === null || typeof value === "object") {
        throw new RuntimeError(first.pos, `${call.name} needs text, got ${describe(value)}`);
      }
      const text = String(value);
      switch (call.name) {
        case "Send":
          return { kind: "action", type: "send", text };
        case "Copy":
          return { kind: "action", type: "copy", text };
        case "OpenUrl":
          if (!/^https?:\/\//i.test(text)) throw new RuntimeError(first.pos, "OpenUrl needs an http:// or https:// URL");
          return { kind: "action", type: "openUrl", url: text };
      }
      throw new RuntimeError(call.pos, `unknown action \`${call.name}\``);
    },

    /** Evaluated items or arguments with `...list` spread in place, and the position each came from. */
    spread(exprs: readonly Expr[], scope: Scope | null): { values: Value[]; positions: Pos[] } {
      const values: Value[] = [];
      const positions: Pos[] = [];
      for (const expr of exprs) {
        if (expr.type !== "spread") {
          values.push(this.expr(expr, scope));
          positions.push(expr.pos);
          continue;
        }
        const list = this.expr(expr.value, scope);
        if (!isList(list)) throw new RuntimeError(expr.pos, `\`...\` needs a list here, got ${describe(list)}`);
        checkLength(list, expr.pos);
        for (const item of list) {
          values.push(item);
          positions.push(expr.pos);
        }
      }
      return { values, positions };
    },

    /** Numbers in a list; nulls are skipped. */
    numbers(value: Value, pos: Pos, label: string): number[] {
      if (!isList(value)) throw new RuntimeError(pos, `${label} needs a list of numbers, got ${describe(value)}`);
      const out: number[] = [];
      for (const item of value) if (item !== null) out.push(this.number(item, pos, label));
      return out;
    },

    callFunction(call: CallExpr, scope: Scope | null): Value {
      const { values: args, positions } = this.spread(call.args, scope);
      const posAt = (index: number) => positions[index] ?? call.pos;
      const name = call.name;
      const numberAt = (index: number) => this.number(args[index] ?? null, posAt(index), `${name}()`);
      const digitsAt = (index: number) =>
        index < args.length ? this.digits(args[index], posAt(index), `${name}()`) : undefined;
      switch (name) {
        case "round":
          return finite(roundTo(numberAt(0), digitsAt(1) ?? 0));
        case "fmt":
          return fmt(numberAt(0), digitsAt(1));
        case "abs":
          return Math.abs(numberAt(0));
        case "floor":
          return Math.floor(numberAt(0));
        case "ceil":
          return Math.ceil(numberAt(0));
        case "sqrt":
          return finite(Math.sqrt(numberAt(0)));
        case "pow":
          return finite(numberAt(0) ** numberAt(1));
        case "sum":
          return finite(this.numbers(args[0] ?? null, posAt(0), "sum()").reduce((total, n) => total + n, 0));
        case "min":
        case "max": {
          const values =
            args.length === 1 && isList(args[0])
              ? this.numbers(args[0], posAt(0), `${name}()`)
              : args.map((_, index) => numberAt(index));
          if (values.length === 0) return null;
          return name === "min" ? Math.min(...values) : Math.max(...values);
        }
        case "keys":
        case "values":
        case "entries": {
          const object = args[0] ?? null;
          if (!isPlainObject(object)) throw new RuntimeError(posAt(0), `${name}() needs an object, got ${describe(object)}`);
          const pairs = Object.entries(object);
          return checkLength(
            name === "keys" ? pairs.map(([key]) => key) : name === "values" ? pairs.map(([, value]) => value) : pairs,
            call.pos,
          );
        }
        case "Load": {
          const path = this.text(args[0], posAt(0), "Load()");
          const loaded = this.data.get(dataKey({ path, raw: false }));
          if (loaded === undefined) throw new LoadPending(call.pos, path);
          if (!loaded.ok) throw new RuntimeError(call.pos, `Couldn't load ${path}: ${loaded.error}`);
          return loaded.value;
        }
        case "Number": {
          const value = args[0] ?? null;
          if (value === null) return 0;
          if (typeof value === "boolean") return value ? 1 : 0;
          if (typeof value === "number") return value;
          if (typeof value === "string") return finite(Number(value.trim().replaceAll(",", "")));
          throw new RuntimeError(posAt(0), `Number() needs text or a number, got ${describe(value)}`);
        }
        case "String":
          return toText(args[0] ?? null, posAt(0));
        case "parseInt":
          return finite(parseInt(toText(args[0] ?? null, posAt(0)), args.length > 1 ? numberAt(1) : 10));
        case "parseFloat":
          return finite(parseFloat(toText(args[0] ?? null, posAt(0))));
        case "JSON.stringify": {
          const indent = args[2] ?? null;
          if (indent !== null && typeof indent !== "number" && typeof indent !== "string") {
            throw new RuntimeError(posAt(2), `JSON.stringify() indent must be a number or text, got ${describe(indent)}`);
          }
          return checkString(JSON.stringify(args[0] ?? null, null, indent ?? undefined), call.pos);
        }
        case "Date.now":
          return Date.now();
      }
      throw new RuntimeError(call.pos, `\`${name}\` is not a function`);
    },

    /**
     * A named function (`share = p => ...`). Its body sees its parameters and
     * top-level names only; missing arguments are null. Nodes it makes are keyed
     * by the call site too, so two calls never share component state.
     */
    callOwn(call: CallExpr, fn: ArrowExpr, scope: Scope | null): Value {
      const args = this.spread(call.args, scope).values;
      let inner: Scope | null = null;
      for (const [index, name] of fn.params.entries()) {
        inner = { name, value: index < args.length ? args[index] : null, parent: inner };
      }
      const base = this.suffix;
      this.suffix = `${base}@${call.pos.line}:${call.pos.column}`;
      try {
        return this.expr(fn.body, inner);
      } finally {
        this.suffix = base;
      }
    },

    method(call: Extract<Expr, { type: "method" }>, scope: Scope | null): Value {
      const receiver = this.expr(call.object, scope);
      if (receiver === null && call.optional) return null;
      if (isList(receiver) && LAMBDA_METHODS.has(call.name)) return this.lambdaMethod(receiver, call, scope);
      if (isList(receiver) && call.name === "sort") return this.sort(receiver, call, scope);
      if (isList(receiver) && call.name === "reduce") return this.reduce(receiver, call, scope);
      const { values: args, positions } = this.spread(call.args, scope);
      const posAt = (index: number) => positions[index] ?? call.pos;
      const label = `.${call.name}()`;
      const textAt = (index: number) => this.text(args[index] ?? null, posAt(index), label);
      const numberAt = (index: number) => this.number(args[index] ?? null, posAt(index), label);
      const bounds = () => args.map((arg, index) => this.number(arg, posAt(index), label));
      /** A whole count that keeps the result within the text limit. */
      const sizeAt = (index: number, per: number) => {
        const count = numberAt(index);
        if (!Number.isInteger(count) || count < 0) throw new RuntimeError(posAt(index), `${label} needs a whole number of 0 or more`);
        if (count * per > MAX_STRING_LENGTH) throw new RuntimeError(call.pos, `text longer than ${MAX_STRING_LENGTH} characters`);
        return count;
      };
      if (isList(receiver)) {
        switch (call.name) {
          case "join":
            return checkString(
              receiver.map((item) => toText(item, call.pos)).join(args.length > 0 ? textAt(0) : ","),
              call.pos,
            );
          case "slice":
            return receiver.slice(...bounds());
          case "includes":
            return receiver.includes(args[0]);
          case "indexOf":
            return receiver.indexOf(args[0]);
          case "concat":
            return checkLength(receiver.concat(...args), call.pos);
          case "at":
            return at(receiver, numberAt(0));
          case "lastIndexOf":
            return receiver.lastIndexOf(args[0] ?? null);
          case "reverse":
            return [...receiver].reverse();
          case "flat": {
            const depth = args.length > 0 ? numberAt(0) : 1;
            const flatten = (list: readonly Value[], level: number): Value[] =>
              checkLength(list.flatMap((item) => (isList(item) && level > 0 ? flatten(item, level - 1) : [item])), call.pos);
            return flatten(receiver, depth);
          }
        }
      } else if (typeof receiver === "string") {
        switch (call.name) {
          case "includes":
            return receiver.includes(textAt(0));
          case "startsWith":
            return receiver.startsWith(textAt(0));
          case "endsWith":
            return receiver.endsWith(textAt(0));
          case "slice":
            return receiver.slice(...bounds());
          case "split":
            return checkLength(receiver.split(textAt(0)), call.pos);
          case "trim":
            return receiver.trim();
          case "toUpperCase":
            return receiver.toUpperCase();
          case "toLowerCase":
            return receiver.toLowerCase();
          // A function replacement keeps `$&` and similar patterns literal.
          case "replace":
            return checkString(receiver.replace(textAt(0), () => textAt(1)), call.pos);
          case "replaceAll":
            return checkString(receiver.replaceAll(textAt(0), () => textAt(1)), call.pos);
          case "indexOf":
            return receiver.indexOf(textAt(0));
          case "lastIndexOf":
            return receiver.lastIndexOf(textAt(0));
          case "at":
            return at(receiver, numberAt(0));
          case "charAt":
            return receiver.charAt(numberAt(0));
          case "substring":
            return receiver.substring(...(bounds() as [number, number?]));
          case "padStart":
          case "padEnd": {
            const width = sizeAt(0, 1);
            const fill = args.length > 1 ? textAt(1) : " ";
            return call.name === "padStart" ? receiver.padStart(width, fill) : receiver.padEnd(width, fill);
          }
          case "repeat":
            return receiver.repeat(sizeAt(0, receiver.length));
          case "trimStart":
            return receiver.trimStart();
          case "trimEnd":
            return receiver.trimEnd();
        }
      } else if (typeof receiver === "number" && call.name === "toFixed") {
        const digits = args.length > 0 ? this.digits(args[0], posAt(0), label) : 0;
        return roundTo(receiver, digits).toFixed(digits);
      } else if (typeof receiver === "number" && call.name === "toLocaleString") {
        return fmt(receiver, undefined, 3);
      }
      if (call.name === "toString" && (typeof receiver === "number" || typeof receiver === "string" || typeof receiver === "boolean")) {
        if (args.length === 0 || typeof receiver !== "number") return String(receiver);
        const radix = numberAt(0);
        if (!Number.isInteger(radix) || radix < 2 || radix > 36) throw new RuntimeError(posAt(0), `${label} radix must be a whole number from 2 to 36`);
        return receiver.toString(radix);
      }
      throw new RuntimeError(call.pos, `\`${label}\` is not available on ${describe(receiver)}`);
    },

    /** A sorted copy; without a comparator, numbers sort numerically and anything else as text. */
    sort(list: readonly Value[], call: Extract<Expr, { type: "method" }>, scope: Scope | null): Value {
      checkLength(list, call.pos);
      const fn = call.args[0] && functionArg(call.args[0], this.program.named, "sort");
      if (fn === undefined) {
        return [...list].sort((a, b) =>
          typeof a === "number" && typeof b === "number" ? a - b : toText(a, call.pos).localeCompare(toText(b, call.pos)),
        );
      }
      if (fn.type !== "arrow") throw new RuntimeError(call.pos, "`.sort()` takes a function, as in `(a, b) => a.price - b.price`");
      const [aName, bName] = fn.params;
      return [...list].sort((a, b) => {
        let inner = scope;
        if (aName !== undefined) inner = { name: aName, value: a, parent: inner };
        if (bName !== undefined) inner = { name: bName, value: b, parent: inner };
        return this.number(this.expr(fn.body, inner), fn.body.pos, ".sort()");
      });
    },

    /** `.reduce(fn, start?)`; without `start` the first item starts the total. */
    reduce(list: readonly Value[], call: Extract<Expr, { type: "method" }>, scope: Scope | null): Value {
      checkLength(list, call.pos);
      const fn = call.args[0] && functionArg(call.args[0], this.program.named, "reduce");
      if (fn?.type !== "arrow") throw new RuntimeError(call.pos, "`.reduce()` takes a function, as in `(total, x) => total + x.price, 0`");
      if (call.args.length < 2 && list.length === 0) {
        throw new RuntimeError(call.pos, "`.reduce()` on an empty list needs a starting value, as in `.reduce(f, 0)`");
      }
      const [totalName, itemName, indexName] = fn.params;
      let total = call.args.length > 1 ? this.expr(call.args[1], scope) : list[0];
      for (let index = call.args.length > 1 ? 0 : 1; index < list.length; index++) {
        let inner = scope;
        if (totalName !== undefined) inner = { name: totalName, value: total, parent: inner };
        if (itemName !== undefined) inner = { name: itemName, value: list[index], parent: inner };
        if (indexName !== undefined) inner = { name: indexName, value: index, parent: inner };
        total = this.expr(fn.body, inner);
      }
      return total;
    },

    lambdaMethod(list: readonly Value[], call: Extract<Expr, { type: "method" }>, scope: Scope | null): Value {
      checkLength(list, call.pos);
      const fn = call.args[0] && functionArg(call.args[0], this.program.named, call.name);
      if (fn?.type !== "arrow") throw new RuntimeError(call.pos, `\`.${call.name}()\` takes a function, as in \`x => x.price\``);
      const [itemName, indexName] = fn.params;
      const apply = (item: Value, index: number): Value => {
        let inner = scope;
        if (itemName !== undefined) inner = { name: itemName, value: item, parent: inner };
        if (indexName !== undefined) inner = { name: indexName, value: index, parent: inner };
        return this.expr(fn.body, inner);
      };
      switch (call.name) {
        case "map":
        case "flatMap": {
          const base = this.suffix;
          const out = list.map((item, index) => {
            this.suffix = `${base}#${index}`;
            return apply(item, index);
          });
          this.suffix = base;
          return call.name === "map" ? out : checkLength(out.flatMap((item) => (isList(item) ? item : [item])), call.pos);
        }
        case "findIndex":
          return list.findIndex((item, index) => truthy(apply(item, index)));
        case "filter":
          return list.filter((item, index) => truthy(apply(item, index)));
        case "find":
          return list.find((item, index) => truthy(apply(item, index))) ?? null;
        case "some":
          return list.some((item, index) => truthy(apply(item, index)));
        default:
          return list.every((item, index) => truthy(apply(item, index)));
      }
    },
  },
);
type Interpreter = InstanceType<typeof Interpreter>;

/** `$state` initial values in declaration order; an initializer that fails yields null. */
export function initialState(program: Program, data = NO_DATA): Record<string, Value> {
  const values: Record<string, Value> = {};
  const interpreter = new Interpreter(program, values, data);
  for (const decl of program.states) {
    try {
      values[decl.name] = interpreter.expr(decl.value, null);
    } catch (error) {
      interpreter.recover(error, 0, "");
      values[decl.name] = null;
    }
  }
  return values;
}

/** Renders the program's roots against `state`, with `data` holding the files `Load` and `Snippet` read (keyed by `dataKey`). Failures become Error nodes plus diagnostics. */
export function evaluate(
  program: Program,
  state: UiState,
  data = NO_DATA,
): { roots: UiNode[]; diagnostics: Diagnostic[] } {
  const interpreter = new Interpreter(program, state, data);
  const roots: UiNode[] = [];
  for (const expr of program.roots) {
    const key = `${expr.pos.line}:${expr.pos.column}`;
    try {
      roots.push(...interpreter.children(interpreter.expr(expr, null), expr.pos, "a bare expression", key));
    } catch (error) {
      const failure = interpreter.recover(error, 0, "");
      roots.push(
        failure instanceof LoadPending
          ? { kind: "node", type: "Loading", key, props: { path: failure.path, component: null } }
          : { kind: "node", type: "Error", key, props: { message: failure.message } },
      );
      if (failure instanceof LimitError) break;
    }
  }
  return { roots, diagnostics: interpreter.diagnostics.items };
}
