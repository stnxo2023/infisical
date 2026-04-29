import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ReleaseImpact, ReleaseIndex } from "./schema.js";
import { validateUpgradeImpactData } from "./validate.js";

const makeRelease = (overrides: Partial<ReleaseImpact> = {}): ReleaseImpact => {
  const version = overrides.version ?? "v1.2.3";
  const previousTag = overrides.previousTag ?? "v1.2.2";

  return {
    version,
    releasedAt: "2026-04-29T00:00:00.000Z",
    sourceTag: version,
    previousTag,
    impactLevel: "medium",
    summary: "Self-hosted upgrade impact was detected.",
    requiresDbMigration: true,
    breakingChanges: [],
    dbSchemaChanges: [
      {
        title: "Database schema migrations are included",
        description: "This release includes a database migration.",
        action: "Back up the database before upgrading.",
        confidence: "high",
        evidence: [
          {
            type: "file",
            ref: "backend/src/db/migrations/20260429000000_example.ts",
            path: "backend/src/db/migrations/20260429000000_example.ts"
          }
        ]
      }
    ],
    configChanges: [],
    deploymentNotes: [],
    knownIssues: [],
    generatedBy: {
      generator: "@infisical/upgrade-impact",
      generatorVersion: "1",
      model: "test",
      generatedAt: "2026-04-29T00:00:00.000Z",
      sourceRange: {
        from: previousTag,
        to: version
      }
    },
    ...overrides
  };
};

const makeIndex = (versions: ReleaseIndex["versions"]): ReleaseIndex => ({
  schemaVersion: 1,
  generatedAt: "2026-04-29T00:00:00.000Z",
  versions
});

const writeFixture = async ({
  index,
  releases
}: {
  index: ReleaseIndex;
  releases: { fileName: string; release: ReleaseImpact }[];
}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "upgrade-impact-"));
  const releasesDir = path.join(dataDir, "releases");

  await fs.mkdir(releasesDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

  for (const { fileName, release } of releases) {
    await fs.writeFile(path.join(releasesDir, fileName), `${JSON.stringify(release, null, 2)}\n`);
  }

  return dataDir;
};

type ValidationCase = {
  name: string;
  index: ReleaseIndex;
  releases: { fileName: string; release: ReleaseImpact }[];
  expectedErrors: string[];
};

const validRelease = makeRelease();

const validationCases: ValidationCase[] = [
  {
    name: "accepts a valid indexed release file",
    index: makeIndex([
      {
        version: validRelease.version,
        releasedAt: validRelease.releasedAt,
        file: `releases/${validRelease.version}.json`
      }
    ]),
    releases: [{ fileName: `${validRelease.version}.json`, release: validRelease }],
    expectedErrors: []
  },
  {
    name: "rejects a release file missing from the index",
    index: makeIndex([]),
    releases: [{ fileName: `${validRelease.version}.json`, release: validRelease }],
    expectedErrors: [
      `${validRelease.version}.json is not listed in index.json`,
      `${validRelease.version}.json is not referenced by index.json`
    ]
  },
  {
    name: "rejects an impact entry without evidence",
    index: makeIndex([
      {
        version: validRelease.version,
        releasedAt: validRelease.releasedAt,
        file: `releases/${validRelease.version}.json`
      }
    ]),
    releases: [
      {
        fileName: `${validRelease.version}.json`,
        release: makeRelease({
          dbSchemaChanges: [
            {
              title: "Database schema migrations are included",
              description: "This release includes a database migration.",
              action: "Back up the database before upgrading.",
              confidence: "high",
              evidence: []
            }
          ]
        })
      }
    ],
    expectedErrors: [`${validRelease.version}.json failed schema validation`]
  }
];

describe("validateUpgradeImpactData", () => {
  it.each(validationCases)("$name", async ({ index, releases, expectedErrors }) => {
    const dataDir = await writeFixture({ index, releases });
    const result = await validateUpgradeImpactData({ dataDir, skipGitChecks: true });

    for (const expectedError of expectedErrors) {
      expect(result.errors.some((error) => error.includes(expectedError))).toBe(true);
    }

    if (expectedErrors.length === 0) {
      expect(result.errors).toEqual([]);
    }
  });
});
