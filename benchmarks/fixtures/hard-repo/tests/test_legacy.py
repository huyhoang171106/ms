"""Legacy v1 compatibility must remain untouched."""
from chronos.legacy.v1_compat import legacy_clean_amount, legacy_tag_line


def test_legacy_clean_amount():
    assert legacy_clean_amount("$12.345") == 12.35


def test_legacy_tag_line():
    assert legacy_tag_line(["b", "a"]) == "a,b"
    assert legacy_tag_line(None) == ""
