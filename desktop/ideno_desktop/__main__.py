"""`python3 -m ideno_desktop`."""

from __future__ import annotations

import sys

from .app import StartupError, run
from .cli import parse_args


def main(argv: list[str] | None = None) -> int:
    options = parse_args(argv)
    try:
        return run(options)
    except StartupError as error:
        # A startup failure is printed as a message. The user cannot act on a
        # traceback from inside a GUI toolkit, and there is nothing to debug in
        # their environment that the message does not already name.
        print(f"\nideno: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
