#!/usr/bin/env bash
# Run from any directory using this project's Python, without changing system Python.
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
project_python="$project_dir/.venv-main/bin/python"
if [[ ! -x "$project_python" ]]; then
  printf '%s\n' '未找到项目 Python 环境。请在项目根目录执行：' >&2
  printf '%s\n' 'python3.11 -m venv .venv-main' >&2
  exit 1
fi
cd -- "$project_dir"
# ROS and other system packages may export a Python 3.8 PYTHONPATH. The
# project uses its own venv; inherited paths are not required to run it.
exec env -u PYTHONPATH "$project_python" -m server "$@"
