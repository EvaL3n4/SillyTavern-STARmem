"""Shared test setup for bench/modal/tests/.

Pytest auto-loads this conftest before any sibling test module is imported,
so the modal stub + sys.path setup happens exactly once per session
instead of being duplicated across every test file.

Why we stub instead of using real Modal:
    sweep_app.py imports `modal` at top level and calls modal.App(...),
    modal.Image.debian_slim(...), modal.Volume.from_name(...) at import
    time. Unit tests only exercise pure helpers (_detect_elbow,
    render_*_report, stratified_*, etc.) so the real package isn't
    needed — and forcing it as a test dep would block local pytest runs
    on machines where Modal isn't installed.

Why a real ModuleType (not a bare MagicMock):
    pytest probes sys.modules for attributes like `pytest_plugins`. A
    MagicMock answers any attribute access with another MagicMock,
    which fires UsageError when pytest tries to interpret the phantom
    pytest_plugins. types.ModuleType + selective attribute population
    behaves like a real package.

Maintenance contract:
    Every new top-level `from modal import X` in sweep_app.py must be
    mirrored as a `_modal.X = ...` line below. The pre-conftest history
    of this lapsed once (FilePatternMatcher added 2026-04-24, stubs not
    back-filled, all 5 test files broke at collection — see
    docs/plans/phase-12-multi-corpus.md "Deferred bugs" section).
"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from unittest.mock import MagicMock


def _identity_decorator(*args, **kwargs):
    """Stand-in for @app.function / @app.local_entrypoint that returns
    the wrapped function unchanged so import-time decoration is a no-op."""
    def _wrap(fn):
        return fn
    if len(args) == 1 and callable(args[0]) and not kwargs:
        return args[0]
    return _wrap


def _install_modal_stub() -> None:
    """Idempotent installer for the modal sys.modules stub.

    Skips if modal is already loaded with a real `App` attribute (so a
    machine with the real package installed gets the real one). Adds
    every modal symbol that sweep_app.py imports at module scope.
    """
    if "modal" in sys.modules and hasattr(sys.modules["modal"], "App"):
        return

    _modal = types.ModuleType("modal")

    _app = MagicMock()
    _app.function = _identity_decorator
    _app.local_entrypoint = _identity_decorator
    _modal.App = lambda *a, **kw: _app

    _image = MagicMock()
    _image.run_commands.return_value = _image
    _image.add_local_dir.return_value = _image
    _image.pip_install.return_value = _image
    _image.entrypoint.return_value = _image
    _image.env.return_value = _image

    class _Image:
        @staticmethod
        def debian_slim(*a, **kw):
            return _image

        @staticmethod
        def from_registry(*a, **kw):
            return _image

    _modal.Image = _Image

    class _Volume:
        @staticmethod
        def from_name(*a, **kw):
            return MagicMock()

    _modal.Volume = _Volume

    class _Secret:
        @staticmethod
        def from_dotenv(*a, **kw):
            return MagicMock()

        @staticmethod
        def from_name(*a, **kw):
            return MagicMock()

    _modal.Secret = _Secret

    # FilePatternMatcher accepts varargs (one pattern per arg) and is used
    # as a value, not a class to subclass — a callable returning a sentinel
    # is enough for import-time evaluation.
    def _file_pattern_matcher(*patterns, **kwargs):
        return MagicMock(name=f"FilePatternMatcher({patterns!r})")

    _modal.FilePatternMatcher = _file_pattern_matcher

    sys.modules["modal"] = _modal


# Install the stub before any test module imports sweep_app.
_install_modal_stub()

# Make `from sweep_app import ...` work regardless of cwd. Each test file
# previously did this inline; centralising here removes that boilerplate.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
