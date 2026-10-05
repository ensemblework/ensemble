import logging

from ensemble_agent.redact import SecretRedactFilter, install_secret_redaction, redact_text


def test_redact_text_hides_ticket_and_keys() -> None:
    line = redact_text(
        "GET /api/events?ticket=abc123 Authorization: Bearer ens_abc12345 sk-livekeyvalue"
    )
    assert "abc123" not in line.split("ticket=")[1]
    assert "ens_abc12345" not in line
    assert "sk-livekeyvalue" not in line
    assert "ticket=[redacted]" in line


def test_filter_rewrites_the_log_record() -> None:
    record = logging.LogRecord("ensemble", logging.INFO, __file__, 1, "token=%s", ("sk-livekeyvalue",), None)
    assert SecretRedactFilter().filter(record) is True
    assert record.args == ("[redacted]",)


def test_install_is_idempotent() -> None:
    install_secret_redaction()
    install_secret_redaction()
    filters = [item for item in logging.getLogger().filters if isinstance(item, SecretRedactFilter)]
    assert len(filters) == 1
