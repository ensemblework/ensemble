"""Encryption for stored credentials, shared with hub-api (src/lib/secrets.ts).

Format: "v1:" + base64(nonce[12] + ciphertext + tag[16]), AES-256-GCM.
Key: ENSEMBLE_SECRET_KEY (base64, 32 bytes) or <repo>/.ensemble/secret.key,
created on first use by whichever process gets there first.
"""

from __future__ import annotations

import base64
import os
import secrets as _random
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
KEY_FILE = REPO_ROOT / ".ensemble" / "secret.key"


@lru_cache(maxsize=1)
def _key() -> bytes:
    raw = os.environ.get("ENSEMBLE_SECRET_KEY", "").strip()
    if not raw:
        if KEY_FILE.exists():
            raw = KEY_FILE.read_text().strip()
        else:
            KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
            raw = base64.b64encode(_random.token_bytes(32)).decode()
            fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as handle:
                handle.write(raw + "\n")
    key = base64.b64decode(raw)
    if len(key) != 32:
        raise RuntimeError("ENSEMBLE_SECRET_KEY must be 32 bytes, base64-encoded.")
    return key


def encrypt(plain: str) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = _random.token_bytes(12)
    sealed = AESGCM(_key()).encrypt(nonce, plain.encode(), None)
    return "v1:" + base64.b64encode(nonce + sealed).decode()


def decrypt(value: str) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if not value.startswith("v1:"):
        raise ValueError(
            "Stored secret is not encrypted. Expected a v1: value. "
            "Run pnpm secrets:encrypt once with the same ENSEMBLE_SECRET_KEY."
        )
    blob = base64.b64decode(value[3:])
    return AESGCM(_key()).decrypt(blob[:12], blob[12:], None).decode()


def hint(secret: str) -> str:
    return f"…{secret[-4:]}" if len(secret) > 8 else "set"
