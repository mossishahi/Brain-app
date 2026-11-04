#!/usr/bin/env python3
"""Maintainer-only export of pinned, official SPECTER2 weights for CPU inference.

End users download the verified exports; they never need Python or PyTorch.
Dependencies: torch==2.11.0, adapters==1.2.0, onnx==1.20.1,
onnxruntime==1.23.2. See docs/encoder-models.md for release instructions.
"""
import argparse
import hashlib
import importlib.metadata
import json
import shutil
from pathlib import Path

SOURCES = {
    "base": ("allenai/specter2_base", "3447645e1def9117997203454fa4495937bfbd83"),
    "doc": ("allenai/specter2", "2081559630a80fc5851d8f798a05ba81e9468089"),
    "query": ("allenai/specter2_adhoc_query", "3f4448817028388648a74349ece07af4518ec5bd"),
}
SOURCE_SHA256 = {'base': {'config.json': '6d9d68ca2bfeca756fd807e7c81e8e9d3203d8a002dff19cc42b29edd48e8802', 'pytorch_model.bin': '801eda968fad1752fe846a8e572bfdc25202be85544680dda4c99f4589646ebc', 'tokenizer.json': 'fcd3fffca5d8fcc0d5863406f5f491293c1e4658ed503f424a30324b70533c0d', 'tokenizer_config.json': 'afea6e85bb539b2c2de8847d92c2a3ae88334c280abbbdb3baaddc5fb7195242', 'special_tokens_map.json': 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3', 'vocab.txt': 'f0a650346e51ede8996710f79ba65d83fdb8da05b159f17037b74ba4e3a36c6f'}, 'doc': {'adapter_config.json': '1065ad610a661c5169f05d81040fe14429d2cc7ecdf83ed654dca4a62aaf9a8c', 'pytorch_adapter.bin': '5b6105714f78b294daa7e2d181134df12f0acb7a4ec7c1e3c13e512c908db94a'}, 'query': {'adapter_config.json': '106790bd59cf09ce2f8e16b946828a5ea6c3b7112ac9df86996136c50f5c21e6', 'pytorch_adapter.bin': 'c369a7a0d08c82d694f6d1dbdd824415e8c6c98e4317d87e65080fd9a73da0a1'}}
FILES = {
    "base": ["config.json", "pytorch_model.bin", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt"],
    "doc": ["adapter_config.json", "pytorch_adapter.bin"],
    "query": ["adapter_config.json", "pytorch_adapter.bin"],
}
PROBES = {
    "doc": [
        "Spectral graph theory[SEP]Graph Laplacian eigenvectors and manifold geometry.",
        "Manifold learning[SEP]Nonlinear dimensionality reduction preserves local geometry.",
        "Shakespeare[SEP]Literary criticism and dramatic adaptations.",
    ],
    "query": ["manifold learning and spectral graph embeddings", "graph signal processing", "literary criticism"],
}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="Export directory (must be new)")
    parser.add_argument("--upstream", type=Path, help="Optional previously downloaded pinned sources")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)

    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch
    from adapters import AutoAdapterModel
    from huggingface_hub import snapshot_download
    from transformers import AutoTokenizer

    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    torch.manual_seed(0)
    sources = {}
    for role, (repo, revision) in SOURCES.items():
        sources[role] = args.upstream / role if args.upstream else Path(snapshot_download(
            repo, revision=revision, allow_patterns=FILES[role]))
        for name in FILES[role]:
            if not (sources[role] / name).is_file():
                raise RuntimeError(f"Missing pinned source: {role}/{name}")
            if digest(sources[role] / name) != SOURCE_SHA256[role][name]:
                raise RuntimeError(f"Source checksum mismatch: {role}/{name}")
    tokenizer = AutoTokenizer.from_pretrained(sources["base"], local_files_only=True)
    model = AutoAdapterModel.from_pretrained(sources["base"], local_files_only=True, attn_implementation="eager")
    model.eval()
    for role in ("doc", "query"):
        model.load_adapter(str(sources[role]), load_as=role, set_active=False)

    class Embedding(torch.nn.Module):
        def __init__(self, base):
            super().__init__()
            self.base = base

        def forward(self, input_ids, attention_mask):
            cls = self.base(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state[:, 0, :]
            return torch.nn.functional.normalize(cls, p=2, dim=1)

    wrapper = Embedding(model).eval()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    verification, graphs, validation = [], {}, {}
    for role in ("doc", "query"):
        model.set_active_adapters(role)
        inputs = tokenizer(PROBES[role], padding=True, truncation=True, max_length=512,
                           return_tensors="pt", return_token_type_ids=False)
        graph = args.output / f"{role}.onnx"
        print(f"Exporting {role} adapter", flush=True)
        with torch.no_grad():
            torch.onnx.export(wrapper, (inputs["input_ids"], inputs["attention_mask"]), str(graph),
                input_names=["input_ids", "attention_mask"], output_names=["embedding"],
                dynamic_axes={"input_ids": {0: "batch", 1: "sequence"},
                              "attention_mask": {0: "batch", 1: "sequence"}, "embedding": {0: "batch"}},
                opset_version=17, dynamo=False, external_data=False)
        onnx.checker.check_model(str(graph))
        session = ort.InferenceSession(str(graph), sess_options=options, providers=["CPUExecutionProvider"])
        worst = 0.0
        # Check single and padded batches, including truncation at the production limit.
        for texts in [[s] for s in PROBES[role]] + [PROBES[role], ["spectral graph " * 600, PROBES[role][0]]]:
            encoded = tokenizer(texts, padding=True, truncation=True, max_length=512,
                                return_tensors="pt", return_token_type_ids=False)
            with torch.no_grad():
                reference = wrapper(encoded["input_ids"], encoded["attention_mask"]).numpy()
            actual = session.run(["embedding"], {k: v.numpy() for k, v in encoded.items()})[0]
            delta = float(np.max(np.abs(reference - actual)))
            worst = max(worst, delta)
            if not np.isfinite(actual).all() or delta > 2e-5:
                raise RuntimeError(f"{role}: ONNX differs from PyTorch by {delta}")
            if len(texts) == 1:
                verification.append({"text": texts[0], "mode": role,
                                     "head": [round(float(x), 4) for x in reference[0, :8]], "tolerance": 0.0002})
        validation[role] = {"maxAbsoluteError": worst, "singleAndPaddedBatches": True, "truncation512": True}
        graphs[role] = {"file": graph.name, "sha256": digest(graph), "bytes": graph.stat().st_size,
                        "adapter": SOURCES[role][0]}
        print(f"Verified {role}: maximum absolute error {worst:.8g}", flush=True)
        del session

    for filename in ("tokenizer.json", "tokenizer_config.json"):
        shutil.copyfile(sources["base"] / filename, args.output / filename)
    manifest = {"id": "specter2", "dim": 768, "version": 1, "pooling": "cls",
                "models": {repo: revision for repo, revision in SOURCES.values()},
                "docFormat": "{title}[SEP]{body}", "queryFormat": "{text}", "maxTokens": 512,
                "output": "embedding", "verification": verification, "graphs": graphs,
                "tokenizer": {f: digest(args.output / f) for f in ("tokenizer.json", "tokenizer_config.json")},
                "export": {"versions": {p: importlib.metadata.version(p) for p in
                           ("torch", "adapters", "transformers", "onnx", "onnxruntime")},
                           "validation": validation,
                           "sources": {role: {f: digest(sources[role] / f) for f in FILES[role]} for role in SOURCES}}}
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.copyfile(Path(__file__).with_name("specter2-LICENSE.txt"), args.output / "LICENSE")
    (args.output / "NOTICE").write_text(
        "SPECTER2 by Allen Institute for AI (Apache-2.0).\n"
        "https://huggingface.co/allenai/specter2_base\n"
        "https://huggingface.co/allenai/specter2\n"
        "https://huggingface.co/allenai/specter2_adhoc_query\n"
        "Exported for Co-inference: proximity and adhoc_query adapters embedded in separate ONNX graphs, "
        "L2-normalized CLS output. Source revisions and hashes are recorded in manifest.json.\n")
    print(json.dumps({"output": str(args.output), "validation": validation}, indent=2), flush=True)


if __name__ == "__main__":
    main()
