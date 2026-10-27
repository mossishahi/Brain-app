import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryArtifactStore,
  NotesScopeRegistry,
  type AgentExecutionContext,
  type AgentExecutor,
  type AgentResult,
  type AgentTask,
  type JsonObject,
} from "@brainstorm-agentic/core";

import { ArtifactNotesAccess } from "../src/notes-access.js";
import { NotesScopeAgentExecutor, ThinkingArtifactAgentExecutor } from "../src/wiring.js";

/** An executor whose result carries a scripted trace, like the real backends'. */
function tracing(segments: JsonObject[], stepTurns: JsonObject[]): AgentExecutor {
  return {
    async execute(task: AgentTask): Promise<AgentResult> {
      return {
        taskId: task.taskId,
        status: "ok",
        output: {},
        metadata: { thinkingSegments: segments, stepTurns },
      };
    },
  };
}

function chainTask(taskId: string, agentId: string, schema: string, nodeId: string): AgentTask {
  return {
    taskId,
    kind: "brainstorm.brain",
    agentId,
    input: {},
    metadata: { schema, nodeId },
  };
}

const context = (nodePath: string): AgentExecutionContext => ({ runId: "run-1", nodePath });

test("a seat's notes are its first pass and its repairs, in order, and nobody else's", async () => {
  const artifacts = new InMemoryArtifactStore();
  const firstPass = new ThinkingArtifactAgentExecutor(
    tracing([{ turn: 1, text: "Planning the whole chain." }, { turn: 5, text: "Step 1 drafted." }], [{ index: 1, turn: 5 }, { index: 2, turn: 6 }]),
    artifacts,
  );
  await firstPass.execute(chainTask("t1", "member-1", "brainIdeaParts", "develop-idea"), context("root/first-pass/member[0]/develop-idea-execute"));
  await firstPass.execute(chainTask("t2", "member-2", "brainIdeaParts", "develop-idea"), context("root/first-pass/member[1]/develop-idea-execute"));
  // A retried first pass writes its trace again under the same name; only the latest write is a note.
  await new ThinkingArtifactAgentExecutor(
    tracing([{ turn: 1, text: "Planning again." }, { turn: 3, text: "Step 1 drafted." }, { turn: 4, text: "Step 2 drafted." }], [{ index: 1, turn: 3 }, { index: 2, turn: 4 }]),
    artifacts,
  ).execute(chainTask("t1b", "member-1", "brainIdeaParts", "develop-idea"), context("root/first-pass/member[0]/develop-idea-execute"));
  const repair = new ThinkingArtifactAgentExecutor(
    tracing([{ turn: 1, text: "Fixing step 2 after the judge's issue." }, { turn: 2, text: "Rewrote." }], [{ index: 2, turn: 2 }]),
    artifacts,
  );
  await repair.execute(
    chainTask("t3", "member-1", "redevelopmentPatchParts", "redevelop-idea"),
    context("root/review/member[0]/review-steps/cotStep[1]/.../redevelop-idea-execute"),
  );
  // A comment task's own trace is never a note, whatever its agentId.
  await new ThinkingArtifactAgentExecutor(tracing([{ turn: 1, text: "Reviewing." }], []), artifacts).execute(
    chainTask("t4", "member-1", "commentParts", "comment-step"),
    context("root/review/member[1]/.../comment-step-execute"),
  );

  const access = new ArtifactNotesAccess(artifacts);
  const traces = await access.traces({ seat: "member-1", throughStep: 2 });
  assert.deepEqual(
    traces.map((trace) => [trace.kind, trace.order, trace.segments.length, trace.rewrote]),
    [
      ["first-pass", 0, 3, undefined],
      ["redevelopment", 1, 2, [2]],
    ],
  );
  assert.deepEqual((await access.traces({ seat: "member-2", throughStep: 1 })).length, 1);
  assert.deepEqual((await access.traces({ seat: "member-9", throughStep: 1 })).length, 0);
  const refs = await artifacts.list();
  assert.equal(refs[0]!.metadata?.agentId, "member-1");
  assert.equal(refs[0]!.metadata?.schema, "brainIdeaParts");
});

test("the scope registry holds a task's scope exactly while it runs", async () => {
  const scopes = new NotesScopeRegistry();
  let seenDuring: unknown;
  const inner: AgentExecutor = {
    async execute(task: AgentTask): Promise<AgentResult> {
      seenDuring = scopes.get(task.taskId);
      return { taskId: task.taskId, status: "ok", output: {} };
    },
  };
  const executor = new NotesScopeAgentExecutor(inner, scopes);
  await executor.execute(
    { taskId: "review-1", kind: "brainstorm.commentor", input: {}, metadata: { notesScope: { seat: "member-1", throughStep: 2 } } },
    context("root/review"),
  );
  assert.deepEqual(seenDuring, { seat: "member-1", throughStep: 2 });
  assert.equal(scopes.get("review-1"), undefined, "cleared after the task");
  await executor.execute({ taskId: "plain", kind: "brainstorm.brain", input: {} }, context("root/first-pass"));
  assert.equal(seenDuring, undefined, "a task without a scope sees none");
});
