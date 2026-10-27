/**
 * The fact_table tool on the Cursor SDK path: offered exactly when the
 * deployment has a fact table, the task's skill declares `fact-table` and the
 * runtime stamped a factScope; a call reaches the run's FactAccess with the
 * task's requester and task data; and a call in flight holds the stall
 * watchdog, which still trips on an idle stream.
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
  JsonObject,
} from "@brainstorm-agentic/core";
import { FACT_TABLE_DEFINITION } from "@brainstorm-agentic/host-tools";

import {
  CursorAgentExecutor,
  type CursorAgentFactory,
  type CursorSdkAgentOptions,
  type CursorSdkCustomTool,
  type CursorSdkRunResult,
} from "../src/index.js";

/* ------------------------------------------------------------------ fakes */

type CustomTools = Readonly<Record<string, CursorSdkCustomTool>>;

/** One attempt's session: the model's tool calls, made with that attempt's custom tools. */
interface SessionScript {
  readonly callTools?: (tools: CustomTools) => Promise<void> | void;
}

const FINISHED: CursorSdkRunResult = {
  status: "finished",
  result: "",
  usage: { inputTokens: 1, outputTokens: 1 },
};

/** An Agent.create replacement: attempt n runs sessions[n - 1] (the last one repeats). */
function fakeFactory(
  sessions: readonly SessionScript[],
  created: CursorSdkAgentOptions[],
): CursorAgentFactory {
  return async (options) => {
    created.push(options);
    const attempt = created.length;
    const session = sessions[Math.min(attempt, sessions.length) - 1]!;
    let cancelled = false;
    return {
      agentId: `agent-${attempt}`,
      async send() {
        const tools = options.local.customTools ?? {};
        return {
          id: `run-${attempt}`,
          async *stream() {
            yield { type: "thinking", text: "working" };
            if (session.callTools) await session.callTools(tools);
          },
          async wait() {
            return cancelled ? ({ status: "cancelled" } as CursorSdkRunResult) : FINISHED;
          },
          supports: () => true,
          async cancel() {
            cancelled = true;
          },
        };
      },
      close() {
        // nothing to release in the fake
      },
    };
  };
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
    modelId: "composer-2.5",
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

async function submitResult(tools: CustomTools): Promise<void> {
  await tools.submit_result!.execute({ answer: "ok" }, {});
}

/* ------------------------------------------------------------------ tests */

test("fact_table is offered only with a fact table, the capability, and a stamped scope", async () => {
  const facts = fakeFacts();
  const created: CursorSdkAgentOptions[] = [];
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => [],
    facts: facts.access,
    agentFactory: fakeFactory([{ callTools: submitResult }], created),
  });
  const offered = async (task: AgentTask, on: CursorAgentExecutor = executor): Promise<boolean> => {
    const before = created.length;
    const result = await on.execute(task, { runId: "run-facts", nodePath: "root/review" });
    assert.equal(result.status, "ok");
    assert.equal(created.length, before + 1);
    return created[before]!.local.customTools?.fact_table !== undefined;
  };

  assert.equal(await offered(factTask), true);
  const tool = created[0]!.local.customTools!.fact_table!;
  assert.equal(tool.description, FACT_TABLE_DEFINITION.description);
  assert.deepEqual(tool.inputSchema, FACT_TABLE_DEFINITION.inputSchema);
  assert.ok(created[0]!.tools.includes("mcp"), "mcp carries the in-process tool");

  // The skill never declared fact-table: no tool, whatever the metadata says.
  assert.equal(await offered({ ...factTask, allowedCapabilities: [] }), false);
  // The runtime stamped no scope, or one factScopeOf rejects (no agent).
  assert.equal(await offered({ ...factTask, metadata: {} }), false);
  assert.equal(await offered({ ...factTask, metadata: { factScope: { role: "commentor" } } }), false);
  // The broker resolved the capability vacant.
  assert.equal(await offered(vacantTask), false);
  // A deployment without a fact table offers nothing.
  const bare = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => [],
    agentFactory: fakeFactory([{ callTools: submitResult }], created),
  });
  assert.equal(await offered(factTask, bare), false);
  assert.equal(facts.submits.length, 0);
});

test("a fact_table call reaches the FactAccess with the task's requester and task data", async () => {
  const facts = fakeFacts();
  const created: CursorSdkAgentOptions[] = [];
  const answers: Record<string, unknown> = {};
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => [],
    facts: facts.access,
    agentFactory: fakeFactory(
      [
        {
          callTools: async (tools) => {
            const call = (args: JsonObject) => tools.fact_table!.execute(args, {});
            answers.lookup = await call({ claim: CLAIM });
            answers.status = await call({ mode: "status" });
            answers.submit = await call(SUBMIT);
            answers.refused = await call({ mode: "submit", claim: CLAIM });
            facts.state.failWith = "the fact table is unreachable";
            answers.failed = await call({ claim: CLAIM });
            await submitResult(tools);
          },
        },
      ],
      created,
    ),
  });
  const events: AgentProgress[] = [];
  const execution: AgentExecutionContext = {
    runId: "run-facts",
    nodePath: "root/review/commentor[1]",
    signal: new AbortController().signal,
    reportProgress: (event) => events.push(event),
  };
  const result = await executor.execute(factTask, execution);
  assert.equal(result.status, "ok");

  // One submission, recorded against the task's scope; lookups and status are free.
  assert.equal(facts.submits.length, 1);
  assertSubmission(facts.submits[0], execution);

  const lookup = answers.lookup as { mode?: string; results?: Array<{ id?: string; match?: string }> };
  assert.equal(lookup.mode, "lookup");
  assert.deepEqual(lookup.results?.map((hit) => [hit.id, hit.match]), [["F:1", "same claim"]]);
  // status without ids reads the citations the runtime stamped into the scope.
  const status = answers.status as { entries?: Array<{ id?: string; citedAtSteps?: number[] }> };
  assert.deepEqual(status.entries?.map((entry) => [entry.id, entry.citedAtSteps]), [["F:1", [2]]]);
  const submitted = answers.submit as { case?: string; badge?: { id?: string }; next?: string };
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

  // The activity feed words each call without its evidence.
  const starts = events.filter((event) => event.kind === "tool_start" && event.toolName === "fact_table");
  assert.deepEqual(
    starts.map((event) => event.message),
    [
      `Looking up the fact table — ${CLAIM}`,
      "Checking the badges the chain cites",
      `Submitting a fact to the supreme judge — ${CLAIM}`,
      `Submitting a fact to the supreme judge — ${CLAIM}`,
      `Looking up the fact table — ${CLAIM}`,
    ],
  );
  const ends = events.filter((event) => event.kind === "tool_end" && event.toolName === "fact_table");
  assert.deepEqual(
    ends.map((event) => event.message.replace(/ · \d+s$/, "")),
    ["Fact table finished", "Fact table finished", "Fact table finished", "Fact table failed", "Fact table failed"],
  );
  assert.equal(
    events.some((event) => event.message.includes("check_loader.py")),
    false,
    "the evidence never reaches the activity feed",
  );
});

test("a held fact_table call that outlasts stallTimeoutMs does not trip the stall watchdog", async () => {
  // The supreme judge works for minutes while the SDK stream is silent; the
  // watchdog must not take that silence for a dead connection.
  const facts = fakeFacts({ submitDelayMs: 400 });
  const created: CursorSdkAgentOptions[] = [];
  let answer: unknown;
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => [],
    facts: facts.access,
    maxValidationAttempts: 1,
    stallTimeoutMs: 60,
    agentFactory: fakeFactory(
      [
        {
          callTools: async (tools) => {
            answer = await tools.fact_table!.execute(SUBMIT, {});
            await submitResult(tools);
          },
        },
      ],
      created,
    ),
  });
  const events: AgentProgress[] = [];
  const result = await executor.execute(factTask, {
    runId: "run-facts",
    nodePath: "root/review",
    reportProgress: (event) => events.push(event),
  });
  assert.equal(result.status, "ok");
  assert.equal(created.length, 1, "no stall restart while the submission was in flight");
  assert.equal(
    events.some((event) => event.kind === "retry"),
    false,
  );
  assert.equal((answer as { case?: string }).case, "justified-new");
});

test("an idle stream still trips the stall watchdog after a fact_table call returns", async () => {
  const facts = fakeFacts();
  const created: CursorSdkAgentOptions[] = [];
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => [],
    facts: facts.access,
    maxValidationAttempts: 1,
    stallTimeoutMs: 60,
    agentFactory: fakeFactory(
      [
        {
          // The held call returns, then the connection dies: no further
          // messages and no end of stream.
          callTools: async (tools) => {
            await tools.fact_table!.execute({ claim: CLAIM }, {});
            await new Promise(() => undefined);
          },
        },
        { callTools: submitResult },
      ],
      created,
    ),
  });
  const events: AgentProgress[] = [];
  const result = await executor.execute(factTask, {
    runId: "run-facts",
    nodePath: "root/review",
    reportProgress: (event) => events.push(event),
  });
  assert.equal(result.status, "ok");
  assert.equal(created.length, 2, "the wedged attempt restarted in a fresh session");
  assert.ok(
    events.some((event) => event.kind === "retry" && /restarting the task/.test(event.message)),
    "the restart is narrated in the activity feed",
  );
});

test("other custom tools are not held: a slow taxonomy call still trips the stall watchdog", async () => {
  const created: CursorSdkAgentOptions[] = [];
  const taxonomy = {
    async tree() {
      return { revision: 1, nodeCount: 0, outline: "" };
    },
    async resolve(query: string) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { query, found: false as const };
    },
    async suggest() {
      return { queued: 0 };
    },
  };
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => [],
    facts: fakeFacts().access,
    taxonomy: taxonomy as never,
    maxValidationAttempts: 1,
    stallTimeoutMs: 60,
    agentFactory: fakeFactory(
      [
        {
          callTools: async (tools) => {
            await tools.taxonomy_resolve!.execute({ query: "systems biology" }, {});
            await submitResult(tools);
          },
        },
        { callTools: submitResult },
      ],
      created,
    ),
  });
  const result = await executor.execute(
    { ...factTask, allowedCapabilities: ["fact-table", "taxonomy-access"] },
    { runId: "run-facts", nodePath: "root/place" },
  );
  assert.equal(result.status, "ok");
  assert.equal(created.length, 2, "the silent taxonomy call was taken for a stall, as before");
});
