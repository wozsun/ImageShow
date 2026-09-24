import type { z } from "zod";
import type { RuntimeConfig } from "@imageshow/shared/browser";
import {
  parseRuntimeConfig,
  runtimeConfigDefaults,
  runtimeConfigSchema
} from "../runtime-config.ts";

const portableSiteConfigSchema = runtimeConfigSchema.shape.site.omit({
  domain: true,
  assets_base_url: true
});

export const portableRuntimeConfigSchema = runtimeConfigSchema.extend({
  site: portableSiteConfigSchema
});

export type PortableRuntimeConfig = z.infer<typeof portableRuntimeConfigSchema>;

type PortableRuntimeConfigProjection = {
  config: PortableRuntimeConfig;
  recognizedValues: number;
  defaultedValues: number;
  ignoredValues: number;
};

export function extractPortableRuntimeConfig(runtime: RuntimeConfig): PortableRuntimeConfig {
  const { domain: _domain, assets_base_url: _assetsBaseUrl, ...portableSite } = runtime.site;
  return portableRuntimeConfigSchema.parse({ ...runtime, site: portableSite });
}

export function materializeImportedRuntimeConfig(
  portable: PortableRuntimeConfig,
  targetDomain: string,
  targetAssetsBaseUrl = ""
): RuntimeConfig {
  return parseRuntimeConfig({
    ...portable,
    site: {
      ...portable.site,
      domain: targetDomain,
      assets_base_url: targetAssetsBaseUrl
    }
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ConfigPath = PropertyKey[];

type ConfigCandidate = {
  path: ConfigPath;
  value: unknown;
};

function samePortableConfigValueType(defaultValue: unknown, input: unknown) {
  if (Array.isArray(defaultValue)) return Array.isArray(input);
  return typeof input === typeof defaultValue;
}

function collectPortableConfigCandidates(
  defaults: unknown,
  input: unknown,
  path: ConfigPath,
  candidates: ConfigCandidate[]
): number {
  if (input === undefined) return 0;
  if (!isPlainRecord(defaults)) {
    if (!samePortableConfigValueType(defaults, input)) return 1;
    candidates.push({ path, value: structuredClone(input) });
    return 0;
  }
  if (!isPlainRecord(input)) {
    candidates.push({ path, value: structuredClone(input) });
    return 0;
  }

  let unknownValues = 0;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaults, key)) unknownValues += 1;
  }
  for (const [key, defaultValue] of Object.entries(defaults)) {
    unknownValues += collectPortableConfigCandidates(
      defaultValue,
      input[key],
      [...path, key],
      candidates
    );
  }
  return unknownValues;
}

function countPortableConfigValues(value: unknown): number {
  if (!isPlainRecord(value)) return 1;
  let count = 0;
  for (const child of Object.values(value)) {
    count += countPortableConfigValues(child);
  }
  return count;
}

function configPathStartsWith(path: ConfigPath, prefix: ConfigPath) {
  return prefix.length <= path.length
    && prefix.every((segment, index) => segment === path[index]);
}

function setConfigCandidate(
  root: PortableRuntimeConfig,
  candidate: ConfigCandidate
): PortableRuntimeConfig {
  if (candidate.path.length === 0) {
    return structuredClone(candidate.value) as PortableRuntimeConfig;
  }
  let owner = root as unknown as Record<PropertyKey, unknown>;
  for (const segment of candidate.path.slice(0, -1)) {
    owner = owner[segment] as Record<PropertyKey, unknown>;
  }
  owner[candidate.path.at(-1)!] = structuredClone(candidate.value);
  return root;
}

function configFromCandidates(
  defaults: PortableRuntimeConfig,
  candidates: ConfigCandidate[],
  activeCandidates: Set<number>
) {
  let config = structuredClone(defaults);
  for (const [index, candidate] of candidates.entries()) {
    if (activeCandidates.has(index)) {
      config = setConfigCandidate(config, candidate);
    }
  }
  return config;
}

function configIssueSignature(issue: {
  code: string;
  message: string;
  path: readonly PropertyKey[];
}) {
  return JSON.stringify([issue.code, issue.message, issue.path]);
}

/** Keep valid package values and default missing, unknown or invalid input. */
export function projectImportedRuntimeConfig(input: unknown): PortableRuntimeConfigProjection {
  const defaults = extractPortableRuntimeConfig(runtimeConfigDefaults());
  const candidates: ConfigCandidate[] = [];
  const unknownValues = collectPortableConfigCandidates(
    defaults,
    input,
    [],
    candidates
  );
  const activeCandidates = new Set(candidates.map((_, index) => index));

  while (true) {
    const result = portableRuntimeConfigSchema.safeParse(
      configFromCandidates(
        defaults,
        candidates,
        activeCandidates
      )
    );
    if (result.success) {
      return {
        config: result.data,
        recognizedValues: activeCandidates.size,
        defaultedValues: countPortableConfigValues(defaults) - activeCandidates.size,
        ignoredValues: unknownValues + candidates.length - activeCandidates.size
      };
    }

    const directlyInvalid: number[] = [];
    for (const issue of result.error.issues) {
      for (const index of activeCandidates) {
        if (
          configPathStartsWith(issue.path, candidates[index]!.path) &&
          !directlyInvalid.includes(index)
        ) {
          directlyInvalid.push(index);
        }
      }
    }

    // Refinements often report the compared sibling rather than the imported
    // value that made a combination invalid. Try one removal at a time across
    // every affected current section, preferring the candidate that preserves
    // the most other valid values. Directly reported candidates win only when
    // two removals have the same validation result.
    const issueOwnerPaths = result.error.issues.flatMap((issue) =>
      issue.path.length <= 1
        ? [[]]
        : Array.from({ length: issue.path.length - 1 }, (_, index) =>
            issue.path.slice(0, index + 1)
          )
    );
    const relatedCandidates = [...activeCandidates].filter((index) => {
      const candidatePath = candidates[index]!.path;
      return issueOwnerPaths.some(
        (issueOwnerPath) =>
          configPathStartsWith(candidatePath, issueOwnerPath) ||
          configPathStartsWith(issueOwnerPath, candidatePath)
      );
    });
    const fallbackCandidates = [
      ...directlyInvalid,
      ...relatedCandidates.filter((index) => !directlyInvalid.includes(index))
    ];
    if (fallbackCandidates.length === 0) {
      fallbackCandidates.push(...activeCandidates);
    }
    const currentIssueSignatures = new Set(result.error.issues.map(configIssueSignature));
    let bestCandidate = fallbackCandidates[0];
    let bestResolvedIssues = -1;
    let bestRemainingIssues = Number.MAX_SAFE_INTEGER;
    let bestIsValid = false;

    for (const index of fallbackCandidates) {
      const trialCandidates = new Set(activeCandidates);
      trialCandidates.delete(index);
      const trial = portableRuntimeConfigSchema.safeParse(
        configFromCandidates(
          defaults,
          candidates,
          trialCandidates
        )
      );
      const isValid = trial.success;
      const resolvedIssues = isValid
        ? currentIssueSignatures.size
        : [...currentIssueSignatures].filter(
            (signature) =>
              !trial.error.issues.some(
                (trialIssue) => configIssueSignature(trialIssue) === signature
              )
          ).length;
      const remainingIssues = isValid ? 0 : trial.error.issues.length;
      if (
        (isValid && !bestIsValid) ||
        (isValid === bestIsValid && resolvedIssues > bestResolvedIssues) ||
        (isValid === bestIsValid &&
          resolvedIssues === bestResolvedIssues &&
          remainingIssues < bestRemainingIssues)
      ) {
        bestCandidate = index;
        bestIsValid = isValid;
        bestResolvedIssues = resolvedIssues;
        bestRemainingIssues = remainingIssues;
      }
    }

    if (bestCandidate === undefined) {
      throw new Error("Current portable RuntimeConfig defaults are invalid");
    }
    activeCandidates.delete(bestCandidate);
  }
}
