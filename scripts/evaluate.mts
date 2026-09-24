import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { BatchInputError, generateEvaluationKit, runBatch, type KitGenerator } from "@jobber/core";

const usage = "Usage: npm run evaluate -- --input <cases.json> --output <kits.json>";

class CliError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function parsePaths(args: string[]) {
  try {
    const parsed = parseArgs({
      args, options: { input: { type: "string" }, output: { type: "string" } },
      strict: true, allowPositionals: false, tokens: true,
    });
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (seen.has(token.name)) throw new Error("Duplicate option");
      seen.add(token.name);
    }
    if (!parsed.values.input?.trim() || !parsed.values.output?.trim()) {
      throw new Error("Missing path");
    }
    return { input: resolve(parsed.values.input), output: resolve(parsed.values.output) };
  } catch {
    throw new CliError("INVALID_ARGUMENTS", usage);
  }
}

async function checkDistinctPaths(input: string, output: string) {
  if (input === output) throw new CliError("INVALID_ARGUMENTS", "Input and output must be different files.");
  const inputStat = await stat(input);
  try {
    const outputStat = await stat(output);
    if (inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino) {
      throw new CliError("INVALID_ARGUMENTS", "Input and output must be different files.");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function writeAtomically(output: string, content: string) {
  // Same directory ensures rename stays on the same filesystem. Existing output
  // is untouched until a complete replacement is ready.
  const tempDir = await mkdtemp(join(dirname(output), ".jobber-evaluate-"));
  try {
    const temporary = join(tempDir, "kits.json");
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, output);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Dependency injection is for contract tests; the command always uses generateKit. */
export async function runCli(
  args: string[],
  generator: KitGenerator = generateEvaluationKit,
  diagnostic: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): Promise<number> {
  try {
    const paths = parsePaths(args);
    let text: string;
    try {
      await checkDistinctPaths(paths.input, paths.output);
      text = await readFile(paths.input, "utf8");
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("INPUT_READ_FAILED", "Cannot read the input file or inspect the output path.");
    }
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      throw new CliError("INVALID_JSON", "Input file must contain valid JSON.");
    }
    const result = await runBatch(input, generator);
    try {
      await writeAtomically(paths.output, `${JSON.stringify(result, null, 2)}\n`);
    } catch {
      throw new CliError("OUTPUT_WRITE_FAILED", "Cannot write the output file. Ensure its parent directory exists and is writable.");
    }
    const failed = result.kits.filter((kit) => kit.status === "failed").length;
    diagnostic(`Evaluation complete: ${result.kits.length - failed} ok, ${failed} failed. See the output file for case errors.`);
    return 0;
  } catch (error) {
    if (error instanceof CliError || error instanceof BatchInputError) {
      diagnostic(`${error.code}: ${error.message}`);
    } else {
      diagnostic("EVALUATION_FAILED: Unexpected evaluation failure.");
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
