from ensemble_agent.content_parts import has_image_parts
from ensemble_agent.models import _to_anthropic, _with_vision
from ensemble_agent.responses_api import clean_items, items_from_chat

PICTURE = {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="}}
ASKED = [{"type": "text", "text": "What does this chart show?"}, PICTURE]


def test_anthropic_gets_base64_image_blocks_after_tool_results():
    _, messages = _to_anthropic(
        [
            {"role": "assistant", "content": "", "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "hub_view_file", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "t1", "content": '{"ok":true}'},
            {"role": "user", "content": ASKED},
        ]
    )
    assert messages[1] == {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": '{"ok":true}'},
            {"type": "text", "text": "What does this chart show?"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}},
        ],
    }
    assert _to_anthropic([{"role": "user", "content": "hi"}])[1] == [{"role": "user", "content": "hi"}]


def test_responses_gets_input_image_parts_also_from_stored_items():
    assert items_from_chat([{"role": "user", "content": ASKED}]) == [
        {"role": "user", "content": [{"type": "input_text", "text": "What does this chart show?"}, {"type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo="}]}
    ]
    stored = [{"role": "user", "content": [{"type": "input_text", "text": "x"}, {"type": "input_image", "image_url": "data:image/jpeg;base64,/9j/"}]}]
    assert clean_items(stored) == stored


def test_copilot_requests_with_a_picture_say_so():
    assert has_image_parts(ASKED)
    assert _with_vision("copilot", {}, {"messages": [{"role": "user", "content": ASKED}]}) == {"Copilot-Vision-Request": "true"}
    assert _with_vision("copilot", {}, {"input": [{"role": "user", "content": "hi"}]}) == {}
    assert _with_vision("openai", {}, {"messages": [{"role": "user", "content": ASKED}]}) == {}


def test_included_reservation_counts_a_picture_as_a_fixed_allowance():
    from ensemble_agent.included import IMAGE_INPUT_ALLOWANCE, estimate_input_tokens

    huge = "data:image/png;base64," + "A" * 3_000_000
    with_picture = {"input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}, {"type": "input_image", "image_url": huge}]}]}
    without = {"input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}, {"type": "input_image", "image_url": ""}]}]}
    assert estimate_input_tokens(with_picture) == estimate_input_tokens(without) + IMAGE_INPUT_ALLOWANCE
    claude = {"messages": [{"role": "user", "content": [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "A" * 3_000_000}}]}]}
    assert estimate_input_tokens(claude) < 20_000


def test_a_file_goes_whole_to_responses_and_anthropic():
    import base64 as b64

    from ensemble_agent.content_parts import has_attachment_parts

    pdf = {"type": "file", "file": {"filename": "memo.pdf", "file_data": "data:application/pdf;base64,JVBERi0="}}
    notes = {"type": "file", "file": {"filename": "notes.md", "file_data": "data:text/markdown;base64," + b64.b64encode(b"# Notes").decode()}}
    asked = [{"type": "text", "text": "Summarise"}, pdf, notes]
    assert has_attachment_parts(asked)
    assert items_from_chat([{"role": "user", "content": asked}])[0]["content"][1] == {"type": "input_file", "filename": "memo.pdf", "file_data": "data:application/pdf;base64,JVBERi0="}
    _, messages = _to_anthropic([{"role": "user", "content": asked}])
    assert messages[0]["content"][1:] == [
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "JVBERi0="}, "title": "memo.pdf"},
        {"type": "document", "source": {"type": "text", "media_type": "text/plain", "data": "# Notes"}, "title": "notes.md"},
    ]
    stored = [{"role": "user", "content": [{"type": "input_file", "filename": "memo.pdf", "file_data": "data:application/pdf;base64,JVBERi0="}]}]
    assert clean_items(stored) == stored


def test_included_reservation_counts_a_file_as_its_bytes_capped():
    from ensemble_agent.included import FILE_INPUT_ALLOWANCE_MAX, estimate_input_tokens

    empty = estimate_input_tokens({"input": [{"role": "user", "content": [{"type": "input_file", "filename": "big.pdf", "file_data": ""}]}]})
    big = estimate_input_tokens({"input": [{"role": "user", "content": [{"type": "input_file", "filename": "big.pdf", "file_data": "data:application/pdf;base64," + "A" * 4_000_000}]}]})
    assert big == empty + FILE_INPUT_ALLOWANCE_MAX + 3_000
