/**
 * The fact_table tool on the Claude Agent SDK path: the in-process MCP server
 * "facts" (mcp__facts__fact_table) is mounted exactly when the deployment has
 * a fact table, the task's skill declares `fact-table` and the runtime
 * stamped a factScope; a call reaches the run's FactAccess with the task's
 * requester and task data; and the handler holds the session watchdog.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentExecutionContext,
  AgentProgress,
  AgentTask,
  FactAccess,
  FactEntry,
  FactRequester,
  FactSubmission,
  FactSubmitContext,
  PromptRecord,
} from "@brainstorm-agentic/core";
import { FACT_TABLE_DEFINITION } from "@brainstorm-agentic/host-tools";

import {
  ClaudeAgentExecutor,
  type ClaudeAgentQueryFn,
  type ClaudeAgentQueryInput,
} from "../src/index.js";

/* ------------------------------------------------------------------ fakes */

const TOOL = "mcp__facts__fact_table";

function resultMessage(): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({ answer: "ok" }),
    structured_output: { answer: "ok" },
    session_id: "session-facts",
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

interface ToolAnswer {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly isError?: boolean;
}

type FactTableCall = (args: Record<string, unknown>) => Promise<ToolAnswer>;

/**
 * The fact_table handler as the SDK registered it. Like the chain tool in
 * executor.test.ts it is reached through the MCP server's private registry:
 * the real caller is Claude Code, in another process.
 */
function factTableHandler(input: ClaudeAgentQueryInput): FactTableCall {
  const servers = input.options.mcpServers as Record<
    string,
    {
      instance: {
        _registeredTools: Record<
          string,
          { handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolAnswer> }
        >;
      };
    }
  >;
  const registered = servers.facts!.instance._registeredTools.fact_table!;
  return (args) => registered.handler(args, {});
}

/** A session that runs `calls` against the fact_table handler (when given), then answers. */
function factQuery(
  captured: ClaudeAgentQueryInput[],
  calls?: (call: FactTableCall) => Promise<void>,
): ClaudeAgentQueryFn {
  return (input) => ({
    async *[Symbol.asyncIterator]() {
      captured.push(input);
      yield { type: "system", subtype: "init", model: "sonnet" };
      if (calls) await calls(factTableHandler(input));
      yield resultMessage();
    },
  });
}

const CLAIM = "The loader drops every row whose label is missing.";

const ENTRY: FactEntry = {
  id: "F:1",
  status: "justified",
  kind: "code",
  claim: CLAIM,
  conditions: "loader.py line 42",
  method: "re-executed",
  evidence: "python check_loader.py -> 17 rows dropped",
  createdAt: 1,
  updatedAt: 1,
  history: [{ at: 1, event: "issued", by: "S:1" }],
  requesters: [],
};

const BADGE: FactEntry = { ...ENTRY, id: "F:2", conditions: "loader.py line 42, commit abc123" };

interface RecordedSubmit {
  readonly requester: FactRequester;
  readonly submission: FactSubmission;
  readonly context: FactSubmitContext;
}

/** A FactAccess that records each submission and answers it with BADGE as a new badge. */
function fakeFacts(options: { readonly submitDelayMs?: number } = {}) {
  const submits: RecordedSubmit[] = [];
  const state: { failWith?: string } = {};
  const access: FactAccess = {
    async entries() {
      if (state.failWith !== undefined) throw new Error(state.failWith);
      return [ENTRY];
    },
    async submit(requester, submission, context) {
      submits.push({ requester, submission, context });
      if (options.submitDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.submitDelayMs));
      }
      return { submission: `S:${submits.length}`, case: "justified-new", badge: BADGE, conflicts: [] };
    },
  };
  return { access, submits, state };
}

const SCOPE = {
  role: "commentor",
  agent: "commentor-2",
  seat: "member-1",
  step: 3,
  cited: [{ step: 2, ids: ["F:1"] }],
};

const factTask: AgentTask = {
  taskId: "task-facts",
  kind: "brainstorm.commentor",
  input: {
    role: "commentor",
    bindings: {
      input: { title: "Label noise in the loader" },
      files: [{ path: "loader.py" }],
      chain: ["The loader is the only entry point.", "It drops unlabeled rows [F:1]."],
    },
  },
  allowedCapabilities: ["fact-table"],
  outputSchema: {
    name: "answer",
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
  modelRequest: {
    modelId: "sonnet",
    system: "You review one step of a chain.",
    messages: [{ role: "user", content: [{ type: "text", text: "Review step 3." }] }],
  },
  metadata: { factScope: SCOPE },
};

/** The same task after the broker resolved the capability vacant (an offline run has no verifier). */
const vacantTask: AgentTask = {
  ...factTask,
  capabilityPlan: {
    operations: ["fact.lookup", "fact.status", "fact.submit"].map((operationId) => ({
      operationId,
      source: "unavailable" as const,
      toolNames: [],
      capabilityId: "fact-table",
    })),
    hostToolDefinitions: [],
    providerNativeKeys: [],
    capabilities: [
      {
        capabilityId: "fact-table",
        availability: "vacant",
        unavailableOperations: ["fact.lookup", "fact.status", "fact.submit"],
        reason: "This run was launched offline: it has no fact verifier.",
      },
    ],
    unavailableInstructions: "",
  },
};

const SUBMIT = {
  mode: "submit",
  claim: CLAIM,
  conditions: "loader.py line 42, commit abc123",
  evidence: "python check_loader.py -> 17 rows dropped",
  kind: "code",
  step: 3,
  purpose: "Step 3 builds the noise estimate on it.",
};

/** What a submission carries: the task's requester and the task data the verifier may need. */
function assertSubmission(submit: RecordedSubmit | undefined, execution: AgentExecutionContext): void {
  assert.ok(submit, "the submission reached the FactAccess");
  assert.deepEqual(submit.requester, {
    taskId: "task-facts",
    role: "commentor",
    agent: "commentor-2",
    seat: "member-1",
    step: 3,
  });
  assert.deepEqual(submit.submission, {
    claim: CLAIM,
    conditions: "loader.py line 42, commit abc123",
    evidence: "python check_loader.py -> 17 rows dropped",
    kind: "code",
    step: 3,
    purpose: "Step 3 builds the noise estimate on it.",
  });
  assert.deepEqual(submit.context.input, { title: "Label noise in the loader" });
  assert.deepEqual(submit.context.files, [{ path: "loader.py" }]);
  assert.equal(submit.context.execution, execution);
  assert.equal(submit.context.signal, execution.signal);
}

/** The JSON a fact_table answer carries in its one text block. */
function answerJson(answer: ToolAnswer | undefined): Record<string, unknown> {
  assert.ok(answer, "the call was answered");
  assert.equal(answer.isError, undefined);
  return JSON.parse(answer.content[0]!.text) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ tests */

test("the facts MCP server is mounted only with a fact table, the capability, and a stamped scope", async () => {
  const facts = fakeFacts();
  const mounted = async (task: AgentTask, withFacts = true) => {
    const captured: ClaudeAgentQueryInput[] = [];
    const records: PromptRecord[] = [];
    const result = await new ClaudeAgentExecutor({
      token: "setup-token-secret",
      ...(withFacts ? { facts: facts.access } : {}),
      queryFn: factQuery(captured),
    }).execute(task, {
      runId: "run-facts",
      nodePath: "root/review",
      reportPrompt: (record) => records.push(record),
    });
    assert.equal(result.status, "ok");
    const options = captured[0]!.options;
    const tools = options.tools as string[];
    const servers = (options.mcpServers as Record<string, unknown> | undefined) ?? {};
    // The allowlist entry and the server travel together.
    assert.equal(servers.facts !== undefined, tools.includes(TOOL));
    assert.equal((options.allowedTools as string[]).includes(TOOL), tools.includes(TOOL));
    return { offered: tools.includes(TOOL), records };
  };

  const full = await mounted(factTask);
  assert.equal(full.offered, true);
  // The prompt record lists the tool with its own description and inputs.
  const section = full.records[0]!.sections.find((entry) => entry.title.startsWith("Tools offered"));
  const listed = (JSON.parse(section!.body) as Array<{ name: string }>).find((entry) => entry.name === TOOL);
  assert.deepEqual(listed, {
    name: TOOL,
    description: FACT_TABLE_DEFINITION.description,
    input: Object.keys(FACT_TABLE_DEFINITION.inputSchema.properties),
  });

  // The skill never declared fact-table: no tool, whatever the metadata says.
  assert.equal((await mounted({ ...factTask, allowedCapabilities: [] })).offered, false);
  // The runtime stamped no scope, or one factScopeOf rejects (no agent).
  assert.equal((await mounted({ ...factTask, metadata: {} })).offered, false);
  assert.equal((await mounted({ ...factTask, metadata: { factScope: { role: "commentor" } } })).offered, false);
  // The broker resolved the capability vacant.
  assert.equal((await mounted(vacantTask)).offered, false);
  // A deployment without a fact table mounts nothing.
  assert.equal((await mounted(factTask, false)).offered, false);
  assert.equal(facts.submits.length, 0);
});

test("a fact_table call reaches the FactAccess with the task's requester and task data", async () => {
  const facts = fakeFacts();
  const captured: ClaudeAgentQueryInput[] = [];
  const answers: Record<string, ToolAnswer> = {};
  const execution: AgentExecutionContext = {
    runId: "run-facts",
    nodePath: "root/review/commentor[1]",
    signal: new AbortController().signal,
  };
  const result = await new ClaudeAgentExecutor({
    token: "setup-token-secret",
    facts: facts.access,
    queryFn: factQuery(captured, async (call) => {
      answers.lookup = await call({ claim: CLAIM });
      answers.status = await call({ mode: "status" });
      answers.submit = await call(SUBMIT);
      answers.refused = await call({ mode: "submit", claim: CLAIM });
      facts.state.failWith = "the fact table is unreachable";
      answers.failed = await call({ claim: CLAIM });
    }),
  }).execute(factTask, execution);
  assert.equal(result.status, "ok");

  // One submission, recorded against the task's scope; lookups and status are free.
  assert.equal(facts.submits.length, 1);
  assertSubmission(facts.submits[0], execution);

  const lookup = answerJson(answers.lookup) as { mode?: string; results?: Array<{ id?: string; match?: string }> };
  assert.equal(lookup.mode, "lookup");
  assert.deepEqual(lookup.results?.map((hit) => [hit.id, hit.match]), [["F:1", "same claim"]]);
  // status without ids reads the citations the runtime stamped into the scope.
  const status = answerJson(answers.status) as { entries?: Array<{ id?: string; citedAtSteps?: number[] }> };
  assert.deepEqual(status.entries?.map((entry) => [entry.id, entry.citedAtSteps]), [["F:1", [2]]]);
  const submitted = answerJson(answers.submit) as { case?: string; badge?: { id?: string }; next?: string };
  assert.equal(submitted.case, "justified-new");
  assert.equal(submitted.badge?.id, "F:2");
  assert.match(submitted.next ?? "", /Cite \[F:2\]/);
  // A refused request and a failing table both answer as tool errors.
  assert.deepEqual(answers.refused, {
    content: [{ type: "text", text: '`submit` needs conditions (or "none"), evidence, kind.' }],
    isError: true,
  });
  assert.deepEqual(answers.failed, {
    content: [{ type: "text", text: "the fact table is unreachable" }],
    isError: true,
  });
});

test("the activity feed words fact_table calls without their evidence", async () => {
  const events: AgentProgress[] = [];
  const toolUse = (id: string, input: Record<string, unknown>) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: TOOL, input }] },
  });
  const toolResult = (id: string) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id }] },
  });
  const result = await new ClaudeAgentExecutor({
    token: "setup-token-secret",
    facts: fakeFacts().access,
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {
        yield toolUse("fact-1", { claim: CLAIM });
        yield toolResult("fact-1");
        yield toolUse("fact-2", { mode: "status", ids: ["F:1", "F:2"] });
        yield toolResult("fact-2");
        yield toolUse("fact-3", SUBMIT);
        yield toolResult("fact-3");
        yield resultMessage();
      },
    }),
  }).execute(factTask, {
    runId: "run-facts",
    nodePath: "root/review",
    reportProgress: (event) => events.push(event),
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(
    events.filter((event) => event.kind === "tool_start").map((event) => event.message),
    [
      `Looking up the fact table — ${CLAIM}`,
      "Checking badges F:1, F:2",
      `Submitting a fact to the supreme judge — ${CLAIM}`,
    ],
  );
  assert.deepEqual(
    events.filter((event) => event.kind === "tool_end").map((event) => event.message.replace(/ · \d+s$/, "")),
    ["Fact table finished", "Fact table finished", "Fact table finished"],
  );
  assert.equal(
    events.some((event) => event.message.includes("check_loader.py")),
    false,
    "the evidence never reaches the activity feed",
  );
});

test("a held fact_table call that outlasts stallTimeoutMs does not stall the session", async () => {
  const facts = fakeFacts({ submitDelayMs: 400 });
  const captured: ClaudeAgentQueryInput[] = [];
  let answer: ToolAnswer | undefined;
  const result = await new ClaudeAgentExecutor({
    token: "setup-token-secret",
    facts: facts.access,
    stallTimeoutMs: 60,
    queryFn: factQuery(captured, async (call) => {
      answer = await call(SUBMIT);
    }),
  }).execute(factTask, { runId: "run-facts", nodePath: "root/review" });
  assert.equal(result.status, "ok");
  assert.equal(captured.length, 1, "no fresh-session restart while the submission was in flight");
  assert.equal(answerJson(answer).case, "justified-new");
});
