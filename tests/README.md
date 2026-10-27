# Plugin development checks

The production plugin uses Hermes's React/SDK and backend runtime; it has no
frontend build step. Dependencies below are only for tests.

## Python API tests

Use a development Python environment with `fastapi` and `httpx` (the gateway also
provides them):

```sh
python -m pip install -r tests/requirements.txt
python -m unittest discover -s tests -p 'test_*.py' -v
```

These tests cover stale writes, sibling-local block order, ID changes after
reindexing, depth limits, older backend rejection, and successful saves whose
subsequent refresh fails.

## Browser SDK harness

```sh
npm ci --prefix tests
cd tests
npx playwright install chromium
npm test
```

Alternatively set `CHROME_PATH` to an installed Chrome executable. The harness
uses real React with a minimal SDK host and an isolated API fixture. It checks
shared drafts, resize, gateway isolation, save locking across panes, inline
insertion/retry, and chat-draft attachment without automatic submission.
`SCREENSHOT_PATH` optionally saves a preview of the harness.

## Integration with actual logseqd

Run logseqd against a **disposable graph**, then point this test at it. The test
writes new test pages and journal entries; it never needs your production graph.

```sh
# In the logseqd directory, with empty pages/ and journals/ in the graph folder:
clojure -M:run /absolute/path/to/disposable-graph 18471

# In the parent repository, in another terminal:
LOGSEQD_TEST_URL=http://127.0.0.1:18471 python tests/integration_logseqd.py
```

## Dependency regressions

From `logseqd/`:

```sh
clojure -Sdeps '{:paths ["src" "test"]}' -M -e "(require 'logseq-datalog.write-test) (let [r (clojure.test/run-tests 'logseq-datalog.write-test)] (System/exit (+ (:fail r) (:error r))))"
```

From the repository root, Hermes's own loader can validate discovery/registration
without installing the package into your active profile:

```sh
hermes plugins doctor . --ci
```
