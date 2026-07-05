# Faceplugin Deployment

The worker calls Faceplugin's **on-premise Docker services** over HTTP —
no biometric data leaves your infrastructure (helpful for NDPA positioning).

## Services

| Service | Container port | Host port | Worker env var | Endpoint used |
|---------|---------------|-----------|----------------|----------------|
| Liveness detection | 8888 | 8888 | `FACEPLUGIN_LIVENESS_URL` | `POST /liveness-detection` (multipart `file`) |
| Face recognition | 8888 | 8889 | `FACEPLUGIN_FACE_URL` | `POST /face_compare` (multipart `file1`, `file2`, form `threshold`) |
| ID document OCR | — | 8890 | `FACEPLUGIN_IDOCR_URL` | `POST /ocr-id` — optional; unset → sessions degrade to manual_review with `DOCUMENT_OCR_FAILED` |

Both the liveness and face-recognition containers listen on `8888` internally,
so the face container is published on host port `8889`. Endpoint paths are
overridable via the adapter's `paths` option if your licensed build differs.

## Quick start (docker-compose)

From the repo root:

```bash
docker compose -f deploy/faceplugin-compose.yml up -d
# then activate each container's license (see below), once per machine
```

## Setup (per service, manual)

```bash
# Liveness (Faceplugin-ltd/FaceLivenessDetection-Linux)
sudo docker pull faceplugin/face-anti-spoofing:20250605
sudo docker run --name fp-liveness -d -p 127.0.0.1:8888:8888 faceplugin/face-anti-spoofing:20250605

# Face recognition (Faceplugin-ltd/FaceRecognition-Docker)
git clone https://github.com/Faceplugin-ltd/FaceRecognition-Docker
cd FaceRecognition-Docker && sudo docker build -t face-recognition .
sudo docker run --name fp-face -d -p 127.0.0.1:8889:8888 face-recognition

# license activation (per machine, per container):
curl http://127.0.0.1:8888/get-machine-code          # → send machineCode to Faceplugin
curl -X POST http://127.0.0.1:8888/activate-machine \
  -H 'Content-Type: application/json' -d '{"license":"<LICENSE>"}'
# repeat activation against http://127.0.0.1:8889 for the face container
```

**Bind to 127.0.0.1 only** — these services have no auth of their own; only
the worker on the same host may reach them. If worker and Faceplugin run on
separate hosts, front them with a reverse proxy + mTLS or a private network.

## Sizing

CPU-only is fine to start (Faceplugin tests their Linux SDK without GPU).
Liveness + match + OCR per verification ≈ 1–3s CPU on a modest VPS. If p95
processing exceeds the 15s budget (PRD §18), scale worker + containers
together — they're colocated by design.

## Response contracts the adapter relies on

Liveness (`face_state.result`): `"Real" | "Spoof" | "No face" | "Multiple face"`,
plus `liveness_score` (0..1), `is_occluded`, `quality`, `luminance`.

Face compare returns `{ result: { similarity (0..1), status: "Same Person" |
"Different Person" | null, message } }`. When a face cannot be extracted the
container returns `status: null` with `message: "Failed to extract feature on
image1|image2"`; `image2` (the ID face) missing maps to `NO_FACE_ON_DOCUMENT`.
If a licensed build changes these shapes, update
`apps/worker/src/providers/faceplugin.js` (tests in `apps/worker/tests/faceplugin.test.js`).
