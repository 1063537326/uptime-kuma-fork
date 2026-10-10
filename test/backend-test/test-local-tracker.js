const { afterEach, test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "../..");
const temporaryDirectories = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("tracker doctor accepts a completed tracker", () => {
    const tracker = createTracker({
        specStatus: "accepted",
        issues: [{
            file: "01-first.md",
            body: issueBody({ status: "accepted" }),
        }],
    });
    const result = runDoctor(tracker);

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Spec: accepted/);
    assert.match(result.stdout, /Issues: 1 accepted/);
    assert.match(result.stdout, /Ready frontier: none/);
});

test("tracker doctor rejects an accepted spec with unfinished acceptance work", () => {
    const tracker = createTracker({
        specStatus: "accepted",
        issues: [{
            file: "01-first.md",
            body: issueBody({ status: "ready-for-human", unchecked: true }),
        }],
    });

    const result = runDoctor(tracker);

    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /accepted spec requires every issue to be accepted/);
});

test("tracker doctor rejects missing blockers and incomplete accepted issues", () => {
    const tracker = createTracker({
        specStatus: "ready-for-human",
        issues: [{
            file: "01-first.md",
            body: issueBody({ status: "accepted", execution: false, unchecked: true, blockedBy: "02: Missing task." }),
        }],
    });

    const result = runDoctor(tracker);

    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /references missing blocker 02/);
    assert.match(result.stderr, /accepted issue requires Execution: accepted/);
    assert.match(result.stderr, /accepted issue has unchecked acceptance items/);
});

/**
 * @param {string} trackerPath Tracker directory
 * @returns {import("node:child_process").SpawnSyncReturns<string>} CLI result
 */
function runDoctor(trackerPath) {
    return spawnSync("node", ["extra/local-tracker.mjs", trackerPath], {
        cwd: projectRoot,
        encoding: "utf8",
    });
}

/**
 * @param {{ specStatus: string, issues: Array<{ file: string, body: string }> }} input Tracker input
 * @returns {string} Tracker directory
 */
function createTracker(input) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "kuma-tracker-"));
    temporaryDirectories.push(directory);
    mkdirSync(path.join(directory, "issues"));
    writeFileSync(path.join(directory, "spec.md"), [
        "# Test feature",
        "",
        `**Status:** ${input.specStatus}`,
        input.specStatus === "accepted" ? "**Execution:** accepted" : "",
        "**Base-SHA:** 0123456789abcdef0123456789abcdef01234567",
        input.specStatus === "accepted" ? "**Verification:** verification.md" : "",
        "",
    ].join("\n"));
    if (input.specStatus === "accepted") {
        writeFileSync(path.join(directory, "verification.md"), "# Verification\n");
    }
    for (const issue of input.issues) {
        writeFileSync(path.join(directory, "issues", issue.file), issue.body);
    }
    return directory;
}

/**
 * @param {{ status: string, execution?: boolean, unchecked?: boolean, blockedBy?: string }} input Issue fields
 * @returns {string} Issue Markdown
 */
function issueBody({ status, execution = true, unchecked = false, blockedBy = "None (can start immediately)." }) {
    return [
        "# Test issue",
        "",
        `**Blocked by:** ${blockedBy}`,
        `**Status:** ${status}`,
        execution ? "**Execution:** accepted" : "",
        "",
        `- [${unchecked ? " " : "x"}] Acceptance item`,
        "",
    ].join("\n");
}
