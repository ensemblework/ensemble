from ensemble_agent.textutil import chunk_text, truncate_text


def test_truncate_keeps_a_zwj_cluster_and_drops_a_lone_surrogate() -> None:
    family = "👨‍👩‍👧"
    assert truncate_text(family + "x", 1) == ""
    assert truncate_text("a" * 3 + family, 4) == "aaa"
    assert "\ud800" not in truncate_text("ab\ud800cd", 10)
    assert chunk_text("a" * 50) == ["a" * 24, "a" * 24, "aa"]
    chunks = chunk_text("a" * 23 + "😀b", 24)
    assert "".join(chunks) == "a" * 23 + "😀b"
    assert all("\ud800" not in chunk and "\udfff" not in chunk for chunk in chunks)
