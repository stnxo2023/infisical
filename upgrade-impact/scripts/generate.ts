import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import { parse, stringify } from "yaml";
import { z } from "zod";

import { collectEvidence, ReleaseEvidenceBundle } from "../src/evidence.js";
import { compareVersions, isStableVersion } from "../src/git.js";
import { ImpactEntrySchema, ReleaseImpact, ReleaseImpactSchema, ReleaseIndex, ReleaseIndexSchema } from "../src/schema.js";

const GENERATOR_NAME = "@infisical/upgrade-impact";
const GENERATOR_VERSION = "1";
const DEFAULT_MODEL = "gpt-5.4-mini";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(packageRoot, "data");
const releasesDir = path.join(dataDir, "releases");
const indexPath = path.join(dataDir, "index.yaml");

const GeneratedDraftSchema = z.object({
  impactLevel: z.enum(["none", "low", "medium", "high"]),
  summary: z.string().min(1),
  requiresDbMigration: z.boolean(),
  breakingChanges: z.array(ImpactEntrySchema),
  dbSchemaChanges: z.array(ImpactEntrySchema),
  configChanges: z.array(ImpactEntrySchema),
  deploymentNotes: z.array(ImpactEntrySchema),
  knownIssues: z.array(ImpactEntrySchema)
});

type GeneratedDraft = z.infer<typeof GeneratedDraftSchema>;

const parseArgs = () => {
  const args = process.argv.slice(2);
  const getValue = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    tag: getValue("--tag") ?? process.env.GITHUB_REF_NAME,
    dryRun: args.includes("--dry-run"),
    noAi: args.includes("--no-ai"),
    model: getValue("--model") ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL
  };
};

const evidenceForFile = (file: string, description?: string) => ({
  type: "file" as const,
  ref: file,
  path: file,
  description
});

const deterministicDraft = (bundle: ReleaseEvidenceBundle): GeneratedDraft => {
  const dbSchemaChanges: GeneratedDraft["dbSchemaChanges"] = [];
  const configChanges: GeneratedDraft["configChanges"] = [];
  const deploymentNotes: GeneratedDraft["deploymentNotes"] = [];

  if (bundle.migrationFiles.length > 0) {
    dbSchemaChanges.push({
      title: "Database schema migrations are included",
      description: `This release adds ${bundle.migrationFiles.length} database migration file(s). Self-hosted instances should expect the application to run migrations during startup.`,
      action: "Back up the database before upgrading and monitor startup logs until migrations complete.",
      confidence: "high",
      evidence: bundle.migrationFiles.map((file) => evidenceForFile(file, "Added migration file"))
    });
  }

  if (bundle.configFiles.length > 0) {
    configChanges.push({
      title: "Configuration-related files changed",
      description: "This release changes application configuration code that may affect self-hosted deployments.",
      action: "Review the linked configuration changes before upgrading.",
      confidence: "medium",
      evidence: bundle.configFiles.map((file) => evidenceForFile(file, "Configuration-related file changed"))
    });
  }

  if (bundle.deploymentFiles.length > 0 || bundle.selfHostingDocs.length > 0) {
    deploymentNotes.push({
      title: "Deployment-related files changed",
      description: "This release updates deployment or self-hosting documentation files.",
      action: "Review deployment configuration and self-hosting documentation before upgrading.",
      confidence: "medium",
      evidence: [...bundle.deploymentFiles, ...bundle.selfHostingDocs].map((file) =>
        evidenceForFile(file, "Deployment or self-hosting file changed")
      )
    });
  }

  let impactLevel: GeneratedDraft["impactLevel"] = "none";

  if (deploymentNotes.length > 0) {
    impactLevel = "low";
  }

  if (dbSchemaChanges.length > 0 || configChanges.length > 0) {
    impactLevel = "medium";
  }

  let summary = "No self-hosted upgrade impact was detected from deterministic release signals.";

  if (impactLevel !== "none") {
    summary = "Self-hosted upgrade impact was detected from deterministic release signals.";
  }

  return {
    impactLevel,
    summary,
    requiresDbMigration: bundle.migrationFiles.length > 0,
    breakingChanges: [],
    dbSchemaChanges,
    configChanges,
    deploymentNotes,
    knownIssues: []
  };
};

const buildPrompt = (bundle: ReleaseEvidenceBundle) => `You are generating Infisical self-hosted upgrade impact data.

Only include changes that may affect self-hosted customers upgrading Infisical. Focus on breaking changes, database migrations, environment variables, Docker, Helm, Kubernetes, deployment behavior, startup/runtime requirements, manual actions, and known upgrade issues.

Do not include ordinary product features unless they create a self-hosted upgrade action. Every entry must include evidence. If there is no meaningful self-hosted impact, return empty arrays and impactLevel "none".

Return only JSON matching this TypeScript shape:
{
  "impactLevel": "none" | "low" | "medium" | "high",
  "summary": "string",
  "requiresDbMigration": boolean,
  "breakingChanges": ImpactEntry[],
  "dbSchemaChanges": ImpactEntry[],
  "configChanges": ImpactEntry[],
  "deploymentNotes": ImpactEntry[],
  "knownIssues": ImpactEntry[]
}

ImpactEntry:
{
  "title": "string",
  "description": "string",
  "action": "string",
  "confidence": "low" | "medium" | "high",
  "evidence": Evidence[]
}

Evidence:
{
  "type": "commit" | "file" | "pr" | "release" | "url",
  "ref": "string",
  "url": "required for pr, release, url evidence",
  "path": "required for file evidence",
  "description": "optional string"
}

Evidence bundle:
${JSON.stringify(bundle, null, 2)}
`;

const generateWithOpenAi = async (bundle: ReleaseEvidenceBundle, model: string): Promise<GeneratedDraft> => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required unless --no-ai is provided");
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: buildPrompt(bundle) }],
    temperature: 0.2
  });

  const content = response.choices[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI returned an empty response");
  }

  return GeneratedDraftSchema.parse(JSON.parse(content));
};

const assembleReleaseImpact = (bundle: ReleaseEvidenceBundle, draft: GeneratedDraft, model: string): ReleaseImpact => {
  const withReleaseEvidence = (entries: GeneratedDraft[keyof Pick<GeneratedDraft, "breakingChanges">]) =>
    entries.map((entry) => ({ ...entry }));

  return ReleaseImpactSchema.parse({
    version: bundle.tag,
    releasedAt: bundle.releasedAt,
    sourceTag: bundle.tag,
    previousTag: bundle.previousTag,
    impactLevel: draft.impactLevel,
    summary: draft.summary,
    requiresDbMigration: draft.requiresDbMigration || bundle.migrationFiles.length > 0,
    breakingChanges: withReleaseEvidence(draft.breakingChanges),
    dbSchemaChanges: withReleaseEvidence(draft.dbSchemaChanges),
    configChanges: withReleaseEvidence(draft.configChanges),
    deploymentNotes: withReleaseEvidence(draft.deploymentNotes),
    knownIssues: withReleaseEvidence(draft.knownIssues),
    generatedBy: {
      generator: GENERATOR_NAME,
      generatorVersion: GENERATOR_VERSION,
      model,
      generatedAt: new Date().toISOString(),
      sourceRange: {
        from: bundle.previousTag,
        to: bundle.tag
      }
    }
  });
};

const readIndex = async (): Promise<ReleaseIndex> => {
  try {
    return ReleaseIndexSchema.parse(parse(await fs.readFile(indexPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, generatedAt: new Date().toISOString(), versions: [] };
    }

    throw error;
  }
};

const writeReleaseImpact = async (releaseImpact: ReleaseImpact) => {
  await fs.mkdir(releasesDir, { recursive: true });
  await fs.writeFile(path.join(releasesDir, `${releaseImpact.version}.yaml`), stringify(releaseImpact));

  const index = await readIndex();
  const nextVersions = [
    ...index.versions.filter((entry) => entry.version !== releaseImpact.version),
    {
      version: releaseImpact.version,
      releasedAt: releaseImpact.releasedAt,
      file: `releases/${releaseImpact.version}.yaml`
    }
  ].sort((a, b) => compareVersions(a.version, b.version));

  await fs.writeFile(
    indexPath,
    stringify(
      ReleaseIndexSchema.parse({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        versions: nextVersions
      })
    )
  );
};

const main = async () => {
  const { tag, dryRun, noAi, model } = parseArgs();

  if (!tag || !isStableVersion(tag)) {
    throw new Error(`Expected a stable vX.Y.Z tag. Received: ${tag ?? "<missing>"}`);
  }

  const bundle = await collectEvidence(tag);
  let draft: GeneratedDraft;
  let sourceModel = model;

  if (noAi) {
    draft = deterministicDraft(bundle);
    sourceModel = "deterministic";
  } else {
    draft = await generateWithOpenAi(bundle, model);
  }

  const releaseImpact = assembleReleaseImpact(bundle, draft, sourceModel);

  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ evidence: bundle, releaseImpact }, null, 2)}\n`);
    return;
  }

  await writeReleaseImpact(releaseImpact);
  process.stdout.write(`Wrote upgrade impact data for ${releaseImpact.version}\n`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
