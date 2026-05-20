#!/usr/bin/env python3
"""Long-lived reranker server. JSON-line protocol matches embedding_server.py.

Units note: max_length here is TOKENS (typically 512). embedding_server.py's
max_length is CHARACTERS (typically 8000). Not interchangeable.

Spawn:    <venv-python> reranker_server.py <model_dir> <max_length>
Startup:  stderr "READY model=<id> max_length=<N> input_names=<csv> post_processor=<type>\n"
Request:  stdin  {"id": str, "query": str, "docs": [str, ...]}
Response: stdout {"id": str, "scores": [float, ...]}  or  {"id", "error"}
"""
import sys
import json
import signal
import math
from pathlib import Path


def main():
    if len(sys.argv) < 2:
        sys.stderr.write('ERROR usage: reranker_server.py <model_dir> [max_length]\n')
        sys.stderr.flush()
        sys.exit(2)

    model_dir = Path(sys.argv[1]).resolve()
    max_length = int(sys.argv[2]) if len(sys.argv) > 2 else 512
    model_id = model_dir.name

    try:
        from tokenizers import Tokenizer
        import onnxruntime as ort
        import numpy as np
    except ImportError as e:
        sys.stderr.write(f'ERROR import failed: {e}\n')
        sys.stderr.flush()
        sys.exit(1)

    tokenizer_path = model_dir / 'tokenizer.json'
    model_path = model_dir / 'model_quantized.onnx'

    # Read + validate tokenizer.json.
    try:
        with open(tokenizer_path, 'rb') as f:
            tok_json = json.loads(f.read())
        post_proc = (tok_json.get('post_processor') or {}).get('type')
        if post_proc != 'TemplateProcessing':
            sys.stderr.write(
                f'ERROR post_processor={post_proc} unsupported, expected TemplateProcessing\n'
            )
            sys.stderr.flush()
            sys.exit(1)
    except Exception as e:
        sys.stderr.write(f'ERROR tokenizer.json invalid: {e}\n')
        sys.stderr.flush()
        sys.exit(1)

    # xenova-JS compat: @xenova/transformers re-implements SentencePiece and has
    # three known bugs vs the canonical spec — missing add_prefix_space, broken
    # MetaspacePreTokenizer split=true, and UTF-16 surrogate-pair splitting in
    # the normalizer. The Wigolo production reranker has shipped on xenova for a
    # while, so to preserve score parity during the migration we emulate xenova's
    # behavior at the pre_tokenizer level. This matches xenova byte-for-byte on
    # ASCII / multilingual / special-token / edge-case corpora; emoji (bug 3)
    # and long-doc truncation still diverge but those are tracked as
    # accepted-mismatch in the equivalence test. See spec §10.4 + investigation
    # notes for the full breakdown. Mirror this patch in tests/fixtures/dump_tokens.py.
    tok_json['pre_tokenizer'] = {
        'type': 'Metaspace',
        'replacement': '▁',
        'prepend_scheme': 'never',
        'split': False,
    }

    # Clean up any leftover patched-tokenizer files from previous versions
    # (when we used to persist the patched file in model_dir).
    legacy_patched = model_dir / 'tokenizer_xenova_compat.json'
    if legacy_patched.exists():
        try:
            legacy_patched.unlink()
        except OSError:
            pass

    # Patched tokenizer.json written to a temp file rather than the model dir so
    # concurrent server processes for the same model don't race on the write,
    # and the model dir stays clean.
    import tempfile
    import os
    try:
        with tempfile.NamedTemporaryFile(
            mode='w', encoding='utf-8',
            prefix=f'tokenizer_xenova_compat_{os.getpid()}_',
            suffix='.json',
            delete=False,
        ) as tf:
            json.dump(tok_json, tf, ensure_ascii=False)
            patched_path = tf.name
    except Exception as e:
        sys.stderr.write(f'ERROR writing patched tokenizer.json: {e}\n')
        sys.stderr.flush()
        sys.exit(1)

    try:
        tok = Tokenizer.from_file(patched_path)
        tok.enable_truncation(max_length=max_length, strategy='only_second')
        tok.enable_padding(length=max_length, pad_id=1, pad_token='<pad>')
    except Exception as e:
        sys.stderr.write(f'ERROR tokenizer load failed: {e}\n')
        sys.stderr.flush()
        sys.exit(1)
    finally:
        # The tokenizer has already been loaded into memory; we don't need the
        # patched file on disk anymore. Best-effort cleanup.
        try:
            os.unlink(patched_path)
        except OSError:
            pass

    try:
        sess = ort.InferenceSession(str(model_path), providers=['CPUExecutionProvider'])
        input_names = [i.name for i in sess.get_inputs()]
    except Exception as e:
        sys.stderr.write(f'ERROR ONNX session load failed: {e}\n')
        sys.stderr.flush()
        sys.exit(1)

    sys.stderr.write(
        f'READY model={model_id} max_length={max_length} '
        f'input_names={",".join(input_names)} post_processor=TemplateProcessing xenova_compat=1\n'
    )
    sys.stderr.flush()

    signal.signal(signal.SIGINT, signal.SIG_IGN)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get('id')
            query = req['query']
            docs = req['docs']
            scores = []
            for doc in docs:
                enc = tok.encode(query, doc)
                input_ids = np.array([enc.ids], dtype=np.int64)
                attention_mask = np.array([enc.attention_mask], dtype=np.int64)
                feeds = {
                    'input_ids': input_ids,
                    'attention_mask': attention_mask,
                }
                if 'token_type_ids' in input_names:
                    feeds['token_type_ids'] = np.array([enc.type_ids], dtype=np.int64)
                logit = float(sess.run(None, feeds)[0][0][0])
                scores.append(1.0 / (1.0 + math.exp(-logit)))
            sys.stdout.write(json.dumps({'id': req_id, 'scores': scores}) + '\n')
            sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(json.dumps({'id': req_id, 'error': str(e)}) + '\n')
            sys.stdout.flush()


if __name__ == '__main__':
    main()
