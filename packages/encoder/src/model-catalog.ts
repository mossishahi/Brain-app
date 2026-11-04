import type { ModelArtifactBundle } from "./model-artifacts.js";

/** Official Allen AI weights exported and verified by scripts/export-specter2.py.
 * Pin every byte; model assets are separate from the desktop and native engine. */
export const PINNED_MODEL_ARTIFACTS: Readonly<Record<string, ModelArtifactBundle>> = {
  "specter2": {
    "id": "specter2",
    "revision": "encoder-specter2-v1",
    "files": [
      {
        "path": "LICENSE",
        "url": "https://github.com/mossishahi/Brain-app/releases/download/encoder-specter2-v1/LICENSE",
        "sha256": "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
        "size": 11358
      },
      {
        "path": "NOTICE",
        "url": "https://github.com/mossishahi/Brain-app/releases/download/encoder-specter2-v1/NOTICE",
        "sha256": "580d88dd3566522268b99ae0d267104c208e639d3987603c832902c1f00edf6a",
        "size": 367
      },
      {
        "path": "doc.onnx",
        "url": "https://github.com/mossishahi/Brain-app/releases/download/encoder-specter2-v1/doc.onnx",
        "sha256": "ab5bb32f6af878843845e4ac449fdcb77f21722cae2b9c444de92e075babbb25",
        "size": 441340008
      },
      {
        "path": "manifest.json",
        "url": "https://github.com/mossishahi/Brain-app/releases/download/encoder-specter2-v1/manifest.json",
        "sha256": "c8420243f808e7a09dc7561f37d3be01179d8d4f84b589d3e36aa4914c358e9f",
        "size": 4344
      },
      {
        "path": "query.onnx",
        "url": "https://github.com/mossishahi/Brain-app/releases/download/encoder-specter2-v1/query.onnx",
        "sha256": "5f3e107275d16e33c022c65ab5db48c20934950576a97fa5a5cec39804608ca3",
        "size": 441340680
      },
      {
        "path": "tokenizer.json",
        "url": "https://github.com/mossishahi/Brain-app/releases/download/encoder-specter2-v1/tokenizer.json",
        "sha256": "fcd3fffca5d8fcc0d5863406f5f491293c1e4658ed503f424a30324b70533c0d",
        "size": 716830
      },
      {
        "path": "tokenizer_config.json",
        "url": "https://github.com/mossishahi/Brain-app/releases/download/encoder-specter2-v1/tokenizer_config.json",
        "sha256": "afea6e85bb539b2c2de8847d92c2a3ae88334c280abbbdb3baaddc5fb7195242",
        "size": 453
      }
    ]
  }
};
