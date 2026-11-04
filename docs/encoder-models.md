# Scientific embedding models

SPECTER2 is the default embedding model for paper-to-expertise matching. It is
independent of the LLM provider. In SSH mode it runs on the remote research host;
in local mode it runs on the local backend host. The ONNX implementation uses CPU
inference and requires no paid API credential.

## Automatic preparation

The first use downloads the pinned model files separately from the optional ONNX
engine. The model release is approximately **883 MB**, downloaded once per shared
host cache. It does not enlarge the desktop installer. The application verifies
file sizes and SHA-256 checksums, installs atomically, and verifies inference
against reference vectors before using the model. Workers share preparation;
failed downloads can be retried without trusting partial files.

The default cache is `$XDG_CACHE_HOME/co-inference/encoders` when XDG_CACHE_HOME is
an absolute path, otherwise `~/.cache/co-inference/encoders`. Each model revision
has an independent content-addressed directory. Downloads happen when research
needs the model, never when a user opens Settings. Settings reports preparation
status using read-only metadata checks.

For an existing or offline export, set `BRAINSTORM_AGENTIC_ENCODER_DIR` in the
**backend worker's environment** to a directory containing
`specter2/{doc.onnx,query.onnx,tokenizer.json,tokenizer_config.json,manifest.json}`.
An explicit directory is authoritative and is never overwritten by automatic
provisioning. The export must satisfy the checksum and conformance contract; the
original PyTorch weights alone are not a usable export.

If a requested semantic model cannot be loaded or its topic vectors cannot be
prepared, literature retrieval/committee composition stops with an actionable
error. It never silently changes to the hash encoder. Explicitly choosing
`hash-ngram-v1` remains possible for offline fixtures/diagnostics. Saved evidence
made with another encoder cannot be recomposed as if it used SPECTER2. A completed
committee already in a checkpoint is not automatically rewritten: start a fresh
run to regenerate it.

The pinned ONNX engine does not support Intel macOS. Managed preparation reports
this limitation before downloading the model; using a supported remote host is
an alternative. The desktop interface itself continues to support Intel Macs.

## Model provenance and export

The model source is [Allen AI SPECTER2](https://huggingface.co/allenai/specter2_base),
with its [proximity adapter](https://huggingface.co/allenai/specter2) for documents
and [adhoc-query adapter](https://huggingface.co/allenai/specter2_adhoc_query) for
queries. `packages/encoder/scripts/export-specter2.py` pins all three upstream
commit revisions. The export records source checksums, dependency versions and
full-vector comparisons between PyTorch and ONNX on individual, padded, and
512-token-truncated inputs. Documents use `title[SEP]abstract`; outputs are
768-dimensional L2-normalized CLS vectors. Each graph contains its own adapter.

Maintainer export (Python is not required on users' hosts):

```sh
python -m venv /tmp/specter-export
/tmp/specter-export/bin/pip install torch==2.11.0 adapters==1.2.0 onnx==1.20.1 onnxruntime==1.23.2
/tmp/specter-export/bin/python packages/encoder/scripts/export-specter2.py --output /tmp/specter-models/specter2
BRAINSTORM_AGENTIC_ENCODER_DIR=/tmp/specter-models npm test -w @brainstorm-agentic/encoder
```

Publish the seven model files, including LICENSE and NOTICE, to a dedicated model
release. Update `packages/encoder/src/model-catalog.ts` with the verified immutable
URLs, byte lengths and hashes. Do not replace assets already pinned by a released
application. Model assets are public downloads; no repository token is sent by
the application. The v1 assets are at
[encoder-specter2-v1](https://github.com/mossishahi/Brain-app/releases/tag/encoder-specter2-v1).

For diagnosis of the affected spectral-embedding run,
`packages/encoder/scripts/replay-panel-embeddings.mjs` re-embeds its saved paper
corpus and needs, then recomputes the committee. It takes `--artifacts`,
`--catalog`, `--output` and optional `--model-dir`. It writes to a new output
directory, never changes the original job, and makes no literature-search or
LLM requests. Its regression assertions target the saved spectral-paper examples.
