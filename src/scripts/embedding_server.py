#!/usr/bin/env python3
"""
Long-lived embedding server for Wigolo.
Loads a sentence-transformers model once, then processes JSON-line requests
via stdin/stdout.

Protocol:
  - On startup: writes "READY model=<name> dims=<N>\n" to stderr
  - Each stdin line is a JSON object: {"id": "<request_id>", "text": "<text_to_embed>"}
  - Each stdout line is a JSON object: {"id": "<request_id>", "vector": [float, ...]}
  - On error: {"id": "<request_id>", "error": "<message>"}
  - Text is truncated to max_length characters before encoding

Usage:
  python3 embedding_server.py [model_name] [max_length]

Default model: BAAI/bge-small-en-v1.5
Default max_length: 8000
"""

import sys
import json
import signal

def main():
    model_name = sys.argv[1] if len(sys.argv) > 1 else 'BAAI/bge-small-en-v1.5'
    max_length = int(sys.argv[2]) if len(sys.argv) > 2 else 8000

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as e:
        sys.stderr.write(f'ERROR import failed: {e}\n')
        sys.stderr.flush()
        sys.exit(1)

    try:
        model = SentenceTransformer(model_name)
    except Exception as e:
        sys.stderr.write(f'ERROR model load failed: {e}\n')
        sys.stderr.flush()
        sys.exit(1)

    # Determine embedding dimensions from a test encoding
    try:
        test_vec = model.encode('test', normalize_embeddings=True)
        dims = len(test_vec)
    except Exception as e:
        sys.stderr.write(f'ERROR test encoding failed: {e}\n')
        sys.stderr.flush()
        sys.exit(1)

    sys.stderr.write(f'READY model={model_name} dims={dims}\n')
    sys.stderr.flush()

    # Ignore SIGINT (let parent process handle cleanup)
    signal.signal(signal.SIGINT, signal.SIG_IGN)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        request_id = None
        try:
            req = json.loads(line)
            request_id = req.get('id')
            text = req.get('text', '')

            if not isinstance(text, str):
                text = str(text)

            # Truncate to max_length
            text = text[:max_length]

            vector = model.encode(text, normalize_embeddings=True).tolist()

            response = {'id': request_id, 'vector': vector}
            sys.stdout.write(json.dumps(response) + '\n')
            sys.stdout.flush()

        except json.JSONDecodeError as e:
            response = {'id': request_id, 'error': f'JSON decode error: {str(e)}'}
            sys.stdout.write(json.dumps(response) + '\n')
            sys.stdout.flush()

        except Exception as e:
            response = {'id': request_id, 'error': str(e)}
            sys.stdout.write(json.dumps(response) + '\n')
            sys.stdout.flush()


if __name__ == '__main__':
    main()
