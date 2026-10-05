from ensemble_agent.production import format_production_problems, production_problems


def test_dev_ignores_the_default_token_and_bypass() -> None:
    assert production_problems(
        {
            "NODE_ENV": "development",
            "ENSEMBLE_INTERNAL_TOKEN": "dev-internal-token",
            "ENSEMBLE_DEV_AUTH_BYPASS": "true",
            "ENSEMBLE_DEV_LOGIN": "1",
        }
    ) == []
    assert production_problems({}) == []


def test_production_refuses_default_and_example_tokens() -> None:
    good = {"NODE_ENV": "production", "ENSEMBLE_INTERNAL_TOKEN": "a" * 32}
    assert production_problems(good) == []
    for token in ("", "dev-internal-token", "Change-Me", "example-token"):
        problems = production_problems({**good, "ENSEMBLE_INTERNAL_TOKEN": token})
        assert len(problems) == 1
        assert "ENSEMBLE_INTERNAL_TOKEN" in problems[0]
    unset = production_problems({"NODE_ENV": "production"})
    assert 'default value "dev-internal-token"' in unset[0]
    example = production_problems({**good, "ENSEMBLE_INTERNAL_TOKEN": "change-me"})
    assert 'example value "change-me"' in example[0]


def test_production_refuses_auth_bypass_and_dev_login() -> None:
    problems = production_problems(
        {
            "NODE_ENV": "production",
            "ENSEMBLE_INTERNAL_TOKEN": "a" * 32,
            "ENSEMBLE_DEV_AUTH_BYPASS": "true",
            "ENSEMBLE_DEV_LOGIN": "on",
            "ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN": "1",
            "CUSTOM_AUTH_BYPASS": "yes",
            "ENSEMBLE_DEV_USER_ID": "local",
        }
    )
    text = "\n".join(problems)
    assert "ENSEMBLE_DEV_AUTH_BYPASS" in text
    assert "ENSEMBLE_DEV_LOGIN" in text
    assert "ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN" in text
    assert "CUSTOM_AUTH_BYPASS" in text
    assert "ENSEMBLE_DEV_USER_ID" not in text


def test_format_names_the_variable() -> None:
    message = format_production_problems(production_problems({"NODE_ENV": "production"}))
    assert message.startswith("Refusing to start in production:")
    assert "ENSEMBLE_INTERNAL_TOKEN" in message
