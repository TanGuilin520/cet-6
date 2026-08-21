"""Allow the server to be started with ``python3 -m server``."""

from .app import main


if __name__ == "__main__":
    raise SystemExit(main())
