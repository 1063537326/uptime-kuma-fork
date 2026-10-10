import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Parse supported command line arguments.
 * @param {string[]} argv CLI arguments
 * @returns {{ plan: boolean, help: boolean, image: string, logDir: string | null }} Parsed options
 */
function parseArgs(argv) {
    const options = {
        plan: false,
        help: false,
        image: "uptime-kuma-fork:verification",
        logDir: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--plan") {
            options.plan = true;
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else if (arg === "--image" || arg === "--log-dir") {
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) {
                throw new Error(`Missing value for ${arg}`);
            }
            index += 1;
            if (arg === "--image") {
                options.image = value;
            } else {
                options.logDir = path.resolve(projectRoot, value);
            }
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    return options;
}

/**
 * Build the ordered, non-deployment verification phases.
 * @param {string} image Docker image tag
 * @returns {Array<{ name: string, command: string, args: string[] }>} Verification phases
 */
function buildPhases(image) {
    return [
        {
            name: "diff-check",
            command: "git",
            args: ["diff", "--check"],
        },
        {
            name: "test-image",
            command: "docker",
            args: ["build", "-f", ".scratch/Dockerfile.local", "--target", "test", "-t", image, "."],
        },
        {
            name: "lint",
            command: "docker",
            args: ["run", "--rm", image, "npm", "run", "lint"],
        },
        {
            name: "build",
            command: "docker",
            args: ["run", "--rm", image, "npm", "run", "build"],
        },
        {
            name: "backend",
            command: "docker",
            args: [
                "run", "--rm", "--user", "root",
                "-e", "TEST_BACKEND=1",
                "-e", "TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal",
                "-v", "/var/run/docker.sock:/var/run/docker.sock",
                image, "npm", "run", "test-backend:serial",
            ],
        },
        {
            name: "e2e",
            command: "docker",
            args: [
                "run", "--rm",
                "-e", "CI=1",
                "-e", "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium",
                image, "npm", "run", "test-e2e", "--",
                "--reporter=line", "--retries=0", "--max-failures=0",
            ],
        },
    ];
}

/**
 * Render one phase without passing it through a shell.
 * @param {{ command: string, args: string[] }} phase Verification phase
 * @returns {string} Human-readable command
 */
function renderCommand(phase) {
    return [phase.command, ...phase.args]
        .map(value => /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : JSON.stringify(value))
        .join(" ");
}

/**
 * Run one phase and store its complete output in a local log.
 * @param {{ name: string, command: string, args: string[] }} phase Verification phase
 * @param {string} logDir Log directory
 * @returns {Promise<{ name: string, command: string, status: "passed" | "failed", exitCode: number, durationMs: number, log: string }>} Phase result
 */
async function runPhase(phase, logDir) {
    const startedAt = Date.now();
    const log = path.join(logDir, `${phase.name}.log`);
    const stream = createWriteStream(log, { flags: "wx" });
    stream.write(`$ ${renderCommand(phase)}\n\n`);

    process.stdout.write(`▶ ${phase.name}\n`);
    const exitCode = await new Promise((resolve) => {
        const child = spawn(phase.command, phase.args, {
            cwd: projectRoot,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.pipe(stream, { end: false });
        child.stderr.pipe(stream, { end: false });
        child.once("error", (error) => {
            stream.write(`\n${error.stack || error.message}\n`);
            resolve(1);
        });
        child.once("close", code => resolve(code ?? 1));
    });

    await new Promise((resolve, reject) => {
        stream.once("error", reject);
        stream.end(resolve);
    });

    const durationMs = Date.now() - startedAt;
    const status = exitCode === 0 ? "passed" : "failed";
    process.stdout.write(`${exitCode === 0 ? "✓" : "✗"} ${phase.name} (${formatDuration(durationMs)}) — ${log}\n`);
    return {
        name: phase.name,
        command: renderCommand(phase),
        status,
        exitCode,
        durationMs,
        log,
    };
}

/**
 * Write inspectable machine-readable and Markdown summaries.
 * @param {string} logDir Log directory
 * @param {Array<object>} results Phase results
 * @param {string} image Docker image tag
 * @returns {Promise<void>}
 */
async function writeSummary(logDir, results, image) {
    const completed = results.every(result => result.status === "passed");
    const summary = {
        completed,
        image,
        projectRoot,
        generatedAt: new Date().toISOString(),
        phases: results,
    };
    await writeFile(path.join(logDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

    const rows = results.map(result =>
        `| ${result.name} | ${result.status} | ${result.exitCode} | ${formatDuration(result.durationMs)} | ${path.basename(result.log)} |`
    );
    const markdown = [
        "# Private fork verification",
        "",
        `- Result: ${completed ? "passed" : "failed"}`,
        `- Image: \`${image}\``,
        `- Generated: ${summary.generatedAt}`,
        "",
        "| Phase | Status | Exit | Duration | Log |",
        "| --- | --- | ---: | ---: | --- |",
        ...rows,
        "",
    ].join("\n");
    await writeFile(path.join(logDir, "summary.md"), markdown);
}

/**
 * @param {number} durationMs Duration in milliseconds
 * @returns {string} Compact duration
 */
function formatDuration(durationMs) {
    const totalSeconds = Math.round(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function printHelp() {
    process.stdout.write(`Usage: npm run verify:fork -- [options]\n\n` +
        `Options:\n` +
        `  --plan             Print the ordered phases without executing them\n` +
        `  --image <tag>      Override the verification image tag\n` +
        `  --log-dir <path>   Override the ignored local evidence directory\n` +
        `  --help             Show this help\n`);
}

async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 2;
        return;
    }

    if (options.help) {
        printHelp();
        return;
    }

    const phases = buildPhases(options.image);
    if (options.plan) {
        for (const phase of phases) {
            process.stdout.write(`${phase.name}: ${renderCommand(phase)}\n`);
        }
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logDir = options.logDir || path.join(projectRoot, ".scratch", "verification", timestamp);
    await mkdir(logDir, { recursive: true });
    process.stdout.write(`Evidence: ${logDir}\n`);

    const results = [];
    for (const phase of phases) {
        const result = await runPhase(phase, logDir);
        results.push(result);
        if (result.status === "failed") {
            break;
        }
    }
    await writeSummary(logDir, results, options.image);

    if (results.length !== phases.length || results.some(result => result.status === "failed")) {
        process.exitCode = 1;
        process.stderr.write(`Verification failed. See ${path.join(logDir, "summary.md")}\n`);
    } else {
        process.stdout.write(`Verification passed. See ${path.join(logDir, "summary.md")}\n`);
    }
}

await main();
