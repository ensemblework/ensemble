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
