import base64
import os

import pytest

from ensemble_agent.vault import _key, decrypt, encrypt


@pytest.fixture(autouse=True)
def secret_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ENSEMBLE_SECRET_KEY", base64.b64encode(b"k" * 32).decode())
    _key.cache_clear()
    yield
    _key.cache_clear()


def test_round_trip() -> None:
    sealed = encrypt("sk-live-key")
    assert sealed.startswith("v1:")
    assert decrypt(sealed) == "sk-live-key"


def test_decrypt_rejects_plaintext() -> None:
    plain = "sk-plaintext-should-not-echo"
    with pytest.raises(ValueError, match="v1:") as caught:
        decrypt(plain)
    assert plain not in str(caught.value)
    with pytest.raises(ValueError, match="v1:"):
        decrypt("")
    with pytest.raises(Exception):
        decrypt("v1:not-a-real-cipher")
    assert "not-a-real-cipher" not in "v1:not-a-real-cipher".replace("v1:not-a-real-cipher", "")


def test_invalid_ciphertext_does_not_pass_through() -> None:
    with pytest.raises(Exception) as caught:
        decrypt("v1:not-a-real-cipher")
    assert "not-a-real-cipher" not in str(caught.value)
    assert os.environ["ENSEMBLE_SECRET_KEY"]
