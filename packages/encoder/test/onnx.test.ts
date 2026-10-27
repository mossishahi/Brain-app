/**
 * Integration check of the exported ONNX encoders. Runs when
 * BRAINSTORM_AGENTIC_ENCODER_DIR points at the export root; skipped otherwise.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { checkConformance, createEncoderProvider, createLocalEncoder, formatDocument } from "../src/index.js";

const MODEL_DIR = process.env.BRAINSTORM_AGENTIC_ENCODER_DIR;

for (const id of ["specter2", "bge-base-en-v1.5"]) {
  const present = Boolean(MODEL_DIR && existsSync(join(MODEL_DIR, id, "manifest.json")));
  test(`${id}: ONNX encoder loads, passes its verification heads and embeds unit vectors`, { skip: !present }, async () => {
    const provider = createEncoderProvider({ modelDir: MODEL_DIR!, threads: 4 });
    const encoder = await provider.encoder(id);
    assert.ok(!("unavailable" in encoder), "unavailable" in encoder ? encoder.unavailable : "");
    assert.equal(encoder.manifest.dim, 768);
    assert.equal(encoder.manifest.pooling, "cls");
    assert.match(encoder.manifest.models["onnx:doc"] ?? "", /^[0-9a-f]{64}$/);
    const doc = formatDocument(encoder.manifest, "Gaussian message passing", "Nodes are multivariate Gaussian distributions.");
    const [d] = await encoder.embed([doc], "doc");
    const [q] = await encoder.embed(["Gaussian message passing"], "query");
    for (const v of [d!, q!]) {
      let norm = 0;
      for (const x of v) norm += x * x;
      assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-4);
    }
    assert.equal((await encoder.embed([], "doc")).length, 0);
    const int8 = await createLocalEncoder({ modelDir: MODEL_DIR!, id, threads: 4, precision: "int8" });
    try {
      assert.notEqual(int8.manifest.models["onnx:doc"], encoder.manifest.models["onnx:doc"]);
      const conformance = await checkConformance(int8);
      assert.equal(conformance.ok, true, JSON.stringify(conformance.failures));
    } finally {
      await int8.release();
    }
  });
}
