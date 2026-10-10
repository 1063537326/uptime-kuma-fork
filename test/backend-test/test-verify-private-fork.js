const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "../..");

test("private fork verification command exposes a non-mutating execution plan", () => {
    const result = spawnSync("npm", ["run", "verify:fork", "--", "--plan"], {
        cwd: projectRoot,
        encoding: "utf8",
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /diff-check/);
    assert.match(result.stdout, /test-image/);
    assert.match(result.stdout, /lint/);
    assert.match(result.stdout, /build/);
    assert.match(result.stdout, /backend/);
    assert.match(result.stdout, /e2e/);
    assert.doesNotMatch(result.stdout, /compose up|docker restart/);
});

test("private fork verification command rejects unknown options", () => {
    const result = spawnSync("node", ["extra/verify-private-fork.mjs", "--unknown"], {
        cwd: projectRoot,
        encoding: "utf8",
    });

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /Unknown option: --unknown/);
});
