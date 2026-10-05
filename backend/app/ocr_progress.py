"""ocrmypdf plugin: report progress as JSON lines so the backend can track it.

ocrmypdf redirects sys.stdout to stderr while running, so the backend reads both streams.
"""

import json
import sys

from ocrmypdf import hookimpl


class JsonProgressBar:
    def __init__(self, *, total=None, desc=None, unit=None, disable=False, **kwargs):
        self.total = total or 0
        self.desc = desc or ""
        self.n = 0

    def __enter__(self):
        self._emit()
        return self

    def __exit__(self, *exc):
        if self.total:
            self.n = self.total
        self._emit()
        return False

    def update(self, n=1, *, completed=None):
        self.n = completed if completed is not None else self.n + n
        self._emit()

    def _emit(self):
        sys.stdout.write(json.dumps({"desc": self.desc, "n": self.n, "total": self.total}) + "\n")
        sys.stdout.flush()


@hookimpl
def get_progressbar_class():
    return JsonProgressBar
