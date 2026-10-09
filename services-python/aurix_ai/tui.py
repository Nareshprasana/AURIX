"""AURIX terminal control center (stdlib only — no TUI framework).

Render functions are pure (state in, text out) so they are unit-testable.
The interactive loop polls the authoritative TrainingState; it never trains,
promotes, deletes, or implements training logic itself.
"""

from __future__ import annotations

import json
import os
import sys
import time

BANNER = """╔══════════════════════════════════════════════════════╗
║                     A U R I X                        ║
║          Autonomous Trading Intelligence             ║
╚══════════════════════════════════════════════════════╝"""

DOT = {"ok": "●", "bad": "●", "idle": "○"}


def _last_outcome_line(state: dict) -> str | None:
    lo = state.get("last_outcome")
    if not lo:
        return None
    err = f" — {lo['error'][:100]}" if lo.get("error") else ""
    return f"Last: {lo['outcome']} {lo['experiment_id']}{err} (see [4] Logs)"


def render_menu(state: dict, notice: str | None = None) -> str:
    health = state.get("health", "IDLE")
    training_dot = "●" if health in ("RUNNING", "STARTING", "STOPPING") else \
        ("●" if health in ("FAILED", "STALLED") else "○")
    lines = [BANNER, "",
             f"System       ● ONLINE",
             f"Training     {training_dot} {health}",
             "Risk         ● READY",
             "Broker       DISABLED"]
    last = _last_outcome_line(state)
    if last and health == "IDLE":
        # Idle service with history: show IDLE (never a stale FAILED) while
        # keeping the historical outcome visible, diagnostics via logs menu.
        lines += ["", last]
    if notice:
        lines += ["", f"! {notice}"]
    lines += ["",
              "What do you want to do?",
              "",
              "  [1] Start training",
              "  [2] Training status",
              "  [3] Stop training",
              "  [4] View training logs",
              "  [5] System status",
              "  [6] Exit",
              "",
              "Select: "]
    return "\n".join(lines)


def _bar(progress: float | None, width: int = 22) -> str:
    if progress is None:
        return "░" * width + "  ?%"
    filled = max(0, min(width, int(progress * width)))
    pct = int(progress * 100)
    return "█" * filled + "░" * (width - filled) + f" {pct}%"


def _fmt_elapsed(seconds: int | None) -> str:
    if seconds is None:
        return "?"
    m, s = divmod(max(0, int(seconds)), 60)
    return f"{m:02d}:{s:02d}" if m < 60 else f"{m // 60:02d}:{m % 60:02d}:{s:02d}"


def _stage_mark(stages: list, name: str) -> str:
    m = {s["stage"]: s["state"] for s in stages}
    return {"PASSED": "✓", "RUNNING": "→", "FAILED": "✗"}.get(m.get(name, "PENDING"), "○")


def render_training(state: dict) -> str:
    if state.get("health") == "IDLE":
        lines = ["AURIX TRAINING", "─" * 40, "",
                 "Training: IDLE", "No active AURIX training job."]
        last = _last_outcome_line(state)
        if last:
            lines += ["", last]
        lines += ["", "[B] Back   [Q] Quit", ""]
        return "\n".join(lines)
    if state.get("health") == "FAILED":
        return render_failure(state)
    exp = state.get("experiment_id") or "?"
    total = state.get("total_epochs") or "?"
    lines = ["AURIX TRAINING", "─" * 40, "",
             f"Experiment: {exp}",
             f"Dataset:    {state.get('dataset_id') or '?'}",
             f"Worker:     {state.get('worker_name') or '—'}",
             f"PID:        {state.get('worker_pid') or '—'}",
             "",
             f"Epoch {state.get('epoch') or 0} / {total}",
             "",
             _bar(state.get("progress")),
             ""]
    if state.get("loss") is not None:
        lines.append(f"Loss:        {state['loss']:.4f}")
    if state.get("validation_loss") is not None:
        lines.append(f"Val Loss:    {state['validation_loss']:.4f}")
    lines.append(f"Elapsed:     {_fmt_elapsed(state.get('elapsed_seconds'))}")
    lines += ["",
              "Checkpoint:",
              f"{'✓ ' + state['checkpoint'] if state.get('checkpoint') else '○ none yet'}",
              "",
              "Pipeline"]
    for name in ("dataset", "training", "evaluation", "backtest", "governance"):
        lines.append(f"{_stage_mark(state.get('pipeline', []), name)} {name.capitalize()}")
    le = state.get("last_event") or {}
    lines += ["", f"Last event:\n{le.get('timestamp', '?')} {le.get('type', '—')}"]
    if state.get("health") == "STALLED":
        lines += ["", f"⚠ STALLED: {state.get('error') or ''}"]
    hb = state.get("heartbeat_age_seconds")
    lines.append(f"Last heartbeat:\n{hb} seconds ago" if hb is not None else "Last heartbeat:\n—")
    lines += ["", "[S] Stop   [L] Logs   [B] Back   [Q] Quit", ""]
    return "\n".join(lines)


def render_failure(state: dict) -> str:
    bt = state.get("backtest_run") or {}
    lines = ["╔══════════════════════════════════════════════════════╗",
             "║                 🚨 TRAINING FAILED                   ║",
             "╚══════════════════════════════════════════════════════╝",
             "",
             f"Experiment:\n{state.get('experiment_id')}",
             "",
             f"Stage:\n{(state.get('stage') or '?').upper()}",
             "",
             f"Worker:\n{state.get('worker_name') or '—'}\nPID: {state.get('worker_pid') or '—'}",
             "",
             f"Error:\n{state.get('error') or 'unknown (see events log)'}",
             ""]
    if bt:
        lines += [f"stdout:\n{(bt.get('stdout') or 'EMPTY')[:800]}",
                  "",
                  f"stderr:\n{(bt.get('stderr') or 'EMPTY')[:800]}",
                  "",
                  f"exit_code: {bt.get('exit_code', '?')}"]
    else:
        for line in (state.get("log_tail") or [])[-6:]:
            lines.append(f"  {line}")
    lines += ["",
              f"Last checkpoint:\n{state.get('checkpoint') or 'none'}",
              "",
              "Training artifacts:\nPRESERVED",
              "",
              f"Recovery:\n{(state.get('recovery_state') or 'unknown').upper()}",
              "",
              "[B] Back   [Q] Quit", ""]
    return "\n".join(lines)


def render_logs(state: dict, events: list, n: int = 15) -> str:
    lines = ["AURIX TRAINING LOGS", "─" * 40, ""]
    for ev in events[-n:]:
        ts = ev.get("timestamp", "?")
        lines.append(f"{ts} {ev.get('type', '?')}")
        extra = {k: v for k, v in ev.items()
                 if k not in ("experiment_id", "timestamp", "type", "code_version", "worker")}
        if extra:
            lines.append(f"    {json.dumps(extra)[:200]}")
    if not events:
        lines.append("(no events yet)")
    lines += ["", "[B] Back   [Q] Quit", ""]
    _ = state
    return "\n".join(lines)


def render_system(resources: dict, counts: dict) -> str:
    lines = [BANNER, "",
             f"GPU:   {resources.get('gpu_name') or 'none'}",
             f"VRAM:  {resources.get('vram_total_mb') or '?'} MB "
             f"(torch-CUDA: {resources.get('torch_cuda_available')})",
             f"torch: {resources.get('torch_version') or '?'}",
             f"device policy: {resources.get('device_selected')} ({resources.get('reason')})",
             "",
             "Experiments:",
             f"  running: {counts.get('running', 0)}  queued: {counts.get('queued', 0)}  "
             f"done: {counts.get('done', 0)}",
             "",
             "[B] Back   [Q] Quit", ""]
    return "\n".join(lines)


def read_key(timeout_s: float) -> str | None:
    """Single keypress with timeout; None on timeout. No new dependencies."""
    try:
        if os.name == "nt":
            import msvcrt
            end = time.time() + timeout_s
            while time.time() < end:
                if msvcrt.kbhit():
                    ch = msvcrt.getwch()
                    return ch.lower() if ch else None
                time.sleep(0.05)
            return None
        import select
        r, _, _ = select.select([sys.stdin], [], [], timeout_s)
        if r:
            return sys.stdin.read(1).lower()
        return None
    except Exception:
        return None


def clear():
    os.system("cls" if os.name == "nt" else "clear")


def run_interactive(build_state, actions, interval_s: float = 2.0) -> int:
    """Main loop. build_state() -> TrainingState dict. actions: callbacks
    {start, stop, system} provided by the CLI layer (same fns as commands)."""
    if not sys.stdin.isatty():
        print(json.dumps(build_state(), indent=2, default=str))
        return 0
    view = "menu"
    notice = None
    while True:
        try:
            state = build_state()
        except Exception as e:
            state = {"health": "IDLE", "experiment_id": None, "pipeline": [],
                     "last_outcome": None}
            notice = f"state unreadable: {e}"
        clear()
        if view == "menu":
            sys.stdout.write(render_menu(state, notice))
            notice = None
            sys.stdout.flush()
            key = read_key(30.0)
            if key == "1":
                try:
                    actions["start"]()
                except Exception as e:
                    # Never kill the control center: surface the failure and
                    # stay in the menu with the diagnostic visible.
                    notice = f"start failed: {e}"
                view = "training"
            elif key == "2":
                view = "training"
            elif key == "3":
                try:
                    actions["stop"]()
                except Exception as e:
                    notice = f"stop failed: {e}"
                view = "training"
            elif key == "4":
                view = "logs"
            elif key == "5":
                view = "system"
            elif key == "6" or key == "q":
                return 0
        elif view == "training":
            sys.stdout.write(render_training(state))
            sys.stdout.flush()
            key = read_key(interval_s)
            if key == "s":
                try:
                    actions["stop"]()
                except Exception as e:
                    notice = f"stop failed: {e}"
                    view = "menu"
            elif key == "l":
                view = "logs"
            elif key in ("b",):
                view = "menu"
            elif key == "q":
                return 0
        elif view == "logs":
            sys.stdout.write(render_logs(state, actions["events"]()))
            sys.stdout.flush()
            key = read_key(interval_s)
            if key in ("b",):
                view = "menu"
            elif key == "q":
                return 0
        elif view == "system":
            sys.stdout.write(render_system(actions["system"](), actions["counts"]()))
            sys.stdout.flush()
            key = read_key(interval_s)
            if key in ("b",):
                view = "menu"
            elif key == "q":
                return 0
