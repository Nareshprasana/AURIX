"""Backup/restore verification (P2-10). Temp dirs only; never production roots."""

import json
import os


def _fake_runs(root):
    os.makedirs(os.path.join(root, "exp-1", "checkpoints"))
    with open(os.path.join(root, "registry.json"), "w") as f:
        json.dump({"exp-1": {"status": "REJECTED"}}, f)
    with open(os.path.join(root, "exp-1", "experiment.json"), "w") as f:
        json.dump({"experiment_id": "exp-1"}, f)
    with open(os.path.join(root, "exp-1", "manifest.json"), "w") as f:
        json.dump({"status": "COMPLETED"}, f)
    with open(os.path.join(root, "exp-1", "checkpoints", "checkpoint-0001.npz"), "w") as f:
        f.write("weights-bytes")
    return root


def test_backup_verify_restore_roundtrip(tmp_path):
    from aurix_ai.backup import backup_runs, restore_backup, verify_backup
    src = _fake_runs(os.path.join(str(tmp_path), "runs"))
    dest = os.path.join(str(tmp_path), "bak")
    manifest = backup_runs(src, dest)
    assert manifest["files"] and manifest["weights"] == {}
    assert verify_backup(dest) == []
    out = os.path.join(str(tmp_path), "restored")
    result = restore_backup(dest, out)
    assert sorted(result["restored"]) == sorted(manifest["files"])
    assert json.load(open(os.path.join(out, "registry.json"))) == {"exp-1": {"status": "REJECTED"}}
    # Checkpoints were NOT copied by default (metadata-only backup stays small).
    assert not os.path.exists(os.path.join(out, "exp-1", "checkpoints", "checkpoint-0001.npz"))


def test_backup_with_weights_and_tamper_detected(tmp_path):
    from aurix_ai.backup import backup_runs, verify_backup
    src = _fake_runs(os.path.join(str(tmp_path), "runs"))
    dest = os.path.join(str(tmp_path), "bak")
    manifest = backup_runs(src, dest, include_weights=True)
    assert manifest["weights"]
    assert verify_backup(dest) == []
    with open(os.path.join(dest, "exp-1", "manifest.json"), "w") as f:
        f.write("{}")
    problems = verify_backup(dest)
    assert any("manifest.json" in p for p in problems)


def test_restore_refuses_overwrite_and_missing_source(tmp_path):
    import pytest
    from aurix_ai.backup import backup_runs, restore_backup, verify_backup
    assert verify_backup(os.path.join(str(tmp_path), "nope")) == ["missing backup-manifest.json"]
    with pytest.raises(Exception):
        backup_runs(os.path.join(str(tmp_path), "nope"), os.path.join(str(tmp_path), "bak"))
    src = _fake_runs(os.path.join(str(tmp_path), "runs"))
    dest = os.path.join(str(tmp_path), "bak")
    backup_runs(src, dest)
    with pytest.raises(Exception):
        restore_backup(dest, src)  # non-empty destination, no overwrite flag
    # Cleanup discipline holds for temp roots.
    from aurix_ai.orchestrate import assert_safe_cleanup
    assert_safe_cleanup(str(tmp_path))
