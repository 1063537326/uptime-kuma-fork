import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const allowedStatuses = new Set([
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "claimed",
    "ready-for-human",
    "accepted",
    "wontfix",
]);

/**
 * Read and validate one local Markdown tracker.
 * @param {string} trackerDirectory Tracker directory
 * @returns {Promise<{ spec: object, issues: object[], errors: string[], frontier: string[] }>} Doctor result
 */
async function inspectTracker(trackerDirectory) {
    const errors = [];
    const specPath = path.join(trackerDirectory, "spec.md");
    const issuesPath = path.join(trackerDirectory, "issues");
    const specContent = await readRequiredFile(specPath, "spec", errors);
    const spec = {
        status: readField(specContent, "Status"),
        execution: readField(specContent, "Execution"),
        baseSHA: readField(specContent, "Base-SHA"),
        verification: readField(specContent, "Verification"),
    };

    if (!spec.status) {
        errors.push("spec is missing Status");
    } else if (!allowedStatuses.has(spec.status)) {
        errors.push(`spec has unsupported status ${spec.status}`);
    }
    if (!spec.baseSHA || !/^[0-9a-f]{7,40}$/i.test(spec.baseSHA)) {
        errors.push("spec requires an immutable hexadecimal Base-SHA");
    }

    const issueEntries = await readdir(issuesPath, { withFileTypes: true }).catch((error) => {
        errors.push(`cannot read issues directory: ${error.message}`);
        return [];
    });
    const issueFiles = issueEntries
        .filter(entry => entry.isFile() && /^\d{2}-.+\.md$/.test(entry.name))
        .map(entry => entry.name)
        .sort();
    const issues = [];
    const issueIDs = new Set();

    for (const file of issueFiles) {
        const id = file.slice(0, 2);
        if (issueIDs.has(id)) {
            errors.push(`duplicate issue id ${id}`);
            continue;
        }
        issueIDs.add(id);
        const content = await readRequiredFile(path.join(issuesPath, file), file, errors);
        const status = readField(content, "Status");
        const execution = readField(content, "Execution");
        const blockedBy = readField(content, "Blocked by");
        const blockers = blockedBy && !/^None\b/i.test(blockedBy)
            ? [...blockedBy.matchAll(/(?:^|;\s*)(\d{2}):/g)].map(match => match[1])
            : [];
        const issue = { id, file, status, execution, blockedBy, blockers, content };
        issues.push(issue);

        if (!status) {
            errors.push(`${file} is missing Status`);
        } else if (!allowedStatuses.has(status)) {
            errors.push(`${file} has unsupported status ${status}`);
        }
        if (!blockedBy) {
            errors.push(`${file} is missing Blocked by`);
        }
        if (status === "accepted") {
            if (!execution || !/^accepted\b/.test(execution)) {
                errors.push(`${file}: accepted issue requires Execution: accepted`);
            }
            if (/^- \[ \]/m.test(content)) {
                errors.push(`${file}: accepted issue has unchecked acceptance items`);
            }
        }
    }

    const issuesByID = new Map(issues.map(issue => [issue.id, issue]));
    for (const issue of issues) {
        for (const blockerID of issue.blockers) {
            const blocker = issuesByID.get(blockerID);
            if (!blocker) {
                errors.push(`${issue.file} references missing blocker ${blockerID}`);
            } else if (["claimed", "ready-for-human", "accepted"].includes(issue.status) && blocker.status !== "accepted") {
                errors.push(`${issue.file} advanced before blocker ${blockerID} was accepted`);
            }
        }
    }

    if (spec.status === "accepted") {
        if (!spec.execution || !/^accepted\b/.test(spec.execution)) {
            errors.push("accepted spec requires Execution: accepted");
        }
        const unfinished = issues.filter(issue => issue.status !== "accepted");
        if (unfinished.length > 0) {
            errors.push(`accepted spec requires every issue to be accepted: ${unfinished.map(issue => issue.id).join(", ")}`);
        }
        if (!spec.verification) {
            errors.push("accepted spec requires a Verification file");
        } else {
            const verificationPath = path.resolve(trackerDirectory, spec.verification);
            await access(verificationPath).catch(() => {
                errors.push(`accepted spec Verification file does not exist: ${spec.verification}`);
            });
        }
    }

    const frontier = issues
        .filter(issue => issue.status === "ready-for-agent")
        .filter(issue => issue.blockers.every(blockerID => issuesByID.get(blockerID)?.status === "accepted"))
        .map(issue => `${issue.id} ${readHeading(issue.content) || issue.file}`);

    return { spec, issues, errors, frontier };
}

/**
 * @param {string} filePath File path
 * @param {string} label Diagnostic label
 * @param {string[]} errors Error collection
 * @returns {Promise<string>} File content or an empty string
 */
async function readRequiredFile(filePath, label, errors) {
    try {
        return await readFile(filePath, "utf8");
    } catch (error) {
        errors.push(`cannot read ${label}: ${error.message}`);
        return "";
    }
}

/**
 * @param {string} content Markdown content
 * @param {string} name Field name
 * @returns {string | null} Field value
 */
function readField(content, name) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = content.match(new RegExp(`^\\*\\*${escapedName}:\\*\\*\\s*(.+?)\\s*$`, "m"));
    return match?.[1]?.trim() || null;
}

/**
 * @param {string} content Markdown content
 * @returns {string | null} First H1 heading
 */
function readHeading(content) {
    return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
}

/**
 * @param {object[]} issues Issues
 * @returns {string} Status count summary
 */
function summarizeStatuses(issues) {
    const counts = new Map();
    for (const issue of issues) {
        const status = issue.status || "missing-status";
        counts.set(status, (counts.get(status) || 0) + 1);
    }
    return [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, count]) => `${count} ${status}`)
        .join(", ");
}

async function main() {
    const trackerArgument = process.argv[2];
    if (!trackerArgument || process.argv.length > 3) {
        process.stderr.write("Usage: npm run tracker:doctor -- .scratch/<feature-slug>\n");
        process.exitCode = 2;
        return;
    }

    const trackerDirectory = path.resolve(process.cwd(), trackerArgument);
    const result = await inspectTracker(trackerDirectory);
    process.stdout.write(`Tracker: ${trackerDirectory}\n`);
    process.stdout.write(`Spec: ${result.spec.status || "missing-status"}\n`);
    process.stdout.write(`Base-SHA: ${result.spec.baseSHA || "missing"}\n`);
    process.stdout.write(`Issues: ${summarizeStatuses(result.issues) || "none"}\n`);
    process.stdout.write(`Ready frontier: ${result.frontier.length > 0 ? result.frontier.join("; ") : "none"}\n`);

    if (result.errors.length > 0) {
        for (const error of result.errors) {
            process.stderr.write(`ERROR ${error}\n`);
        }
        process.exitCode = 1;
    }
}

await main();
