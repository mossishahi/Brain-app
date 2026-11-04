#!/usr/bin/env node
// Read-only replay of saved retrieval evidence. Writes only to a new output directory.
// No literature search, LLM calls, checkpoint mutation, or changes to the original run.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEncoderProvider, nodeDocument, formatDocument } from '../dist/src/index.js';
import { placeVector } from '../../brainstorm-runtime/dist/src/literature-activities.js';
import { composeInputFromLiterature, composePanelEvidence, topicHierarchy, linearQuantile, round6, seatPanel } from '../../brainstorm-runtime/dist/src/panel-compose.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--artifacts', '--catalog', '--output', '--model-dir'].includes(process.argv[i]) && process.argv[i + 1]);
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
for (const key of ['artifacts', 'catalog', 'output']) assert.ok(args[key], `Missing --${key}`);
await mkdir(args.output, { recursive: false });
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const original = await json(join(args.artifacts, 'artifact-9'));
const oldEvidence = await json(join(args.artifacts, 'artifact-11'));
const taxonomy = await json(join(args.catalog, 'taxonomy.json'));
const texts = await json(join(args.catalog, 'taxonomy-texts.json'));
const params = oldEvidence.params;
assert.equal(params.encoder, 'specter2');
const provider = createEncoderProvider({ ...(args['model-dir'] ? { modelDir: args['model-dir'] } : {}), threads: 4 });
const encoder = await provider.encoder('specter2');
assert.ok(!('unavailable' in encoder), encoder.unavailable);
const topicIds = new Set(taxonomy.nodes.filter(n => n.level === 'topic').map(n => n.id));
const entries = texts.entries.filter(n => topicIds.has(n.id));
assert.equal(entries.length, topicIds.size);
const wrapped = { manifest: encoder.manifest, async embed(batch, mode, signal) {
  const result = [];
  for (let i = 0; i < batch.length; i += 16) {
    result.push(...await encoder.embed(batch.slice(i, i + 16), mode, signal));
    if (batch.length > 100 && (i % 128 === 0 || i + 16 >= batch.length)) console.log(`${mode} embeddings: ${Math.min(i + 16, batch.length)}/${batch.length}`);
  }
  return result;
} };
const index = await provider.nodeIndex(wrapped, taxonomy.revision, entries);
// Save the exact compatible vector index so replay results can be inspected and reused.
await writeFile(join(args.output, 'topics.f32'), Buffer.from(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength));
await writeFile(join(args.output, 'topics.json'), JSON.stringify({ ...index, vectors: undefined }));
const needs = [];
for (const need of original.needs) needs.push((await encoder.embed([need.text], need.mode))[0]);
const papers = original.papers.filter(p => p.decision === 'eligible');
const vectors = await wrapped.embed(papers.map(p => formatDocument(encoder.manifest, p.title, p.abstract)), 'doc');
const dot = (a,b) => { let sum = 0; for (let i=0;i<a.length;i++) sum += a[i]*b[i]; return sum; };
const updated = new Map();
papers.forEach((paper,i) => {
  const p = placeVector(index, vectors[i], params.topicsPerPaper);
  updated.set(paper.pid, { ...paper, placement: p.placement, nextSim: round6(p.nextSim),
    needSims: needs.map(v => round6(dot(v, vectors[i]))), best: p.best });
});
const weakCut = linearQuantile([...updated.values()].map(p => p.best), params.weakPlacementQuantile);
const literature = { ...original, encoder: { id: encoder.manifest.id, dim: encoder.manifest.dim, models: encoder.manifest.models,
  nodeVectorsSha256: index.vectorsSha256, nodeTextsSha256: index.nodeTextsSha256, taxonomyRevision: taxonomy.revision },
  papers: original.papers.map(p => updated.has(p.pid) ? { ...updated.get(p.pid), weak: updated.get(p.pid).best <= weakCut } : p) };
const evidence = composePanelEvidence(composeInputFromLiterature(literature, undefined), params, topicHierarchy(taxonomy.nodes));
const panel = seatPanel(evidence, params.panelSize, params.panelSizeMode);
const names = new Map(taxonomy.nodes.map(n => [n.id,n.name]));
const examples = ['P0028', 'P0181', 'P0674', 'P0044'].map(pid => {
  const p = updated.get(pid); assert.ok(p, `Missing ${pid}`);
  return { pid, title:p.title, placements:p.placement.map(x => ({...x,name:names.get(x.topic)})) };
});
const report = { encoder: literature.encoder, papers: papers.length, taxonomyTopics: entries.length,
  originalPanel: await json(join(args.artifacts, 'artifact-12')), correctedPanel: panel, examples,
  retrievalReused: true, note: 'Re-embeds saved papers and needs; a fresh retrieval could discover different papers.' };
await writeFile(join(args.output, 'report.json'), JSON.stringify(report,null,2)+'\n');
await writeFile(join(args.output, 'panel-evidence.json'), JSON.stringify(evidence,null,2)+'\n');
await writeFile(join(args.output, 'literature.json'), JSON.stringify(literature)+'\n');
console.log(JSON.stringify(report,null,2));
for (const example of examples.slice(0,2)) assert.notEqual(example.placements[0].topic, 'T12912', 'Spectral paper still matches Shakespeare');
for (const member of panel.members) assert.ok(!['Arts and Humanities','Social Sciences'].includes(member.department), `Unrelated member: ${JSON.stringify(member)}`);
await encoder.release?.();
