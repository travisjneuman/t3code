import { useState } from "react";
import { getAddProjectInitialQuery } from "@t3tools/client-runtime/operations/projects";
import {
  createEnvironmentRpcQueryAtomFamily, // Fork add-on(existing-checkout)
  executeAtomQuery,
} from "@t3tools/client-runtime/state/runtime";
import {
  EXISTING_CHECKOUT_WS_METHODS,
  repositoryGroupingKeyOf, // Fork add-on(existing-checkout)
  type EnvironmentId,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime"; // Fork add-on(existing-checkout)
import { appAtomRegistry } from "../rpc/atomRegistry"; // Fork add-on(existing-checkout)
import { useEnvironmentQuery } from "../state/query";
import type { useProject } from "../state/entities";
import type { useEnvironments } from "../state/environments";

// Fork add-on(existing-checkout): Idle TTL 0 reads the other machine's disk fresh each time.
export const existingCheckoutQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:existing-checkout:find",
  tag: EXISTING_CHECKOUT_WS_METHODS.find,
  idleTtlMs: 0,
});

export function useExistingCheckout(
  project: ReturnType<typeof useProject>,
  target: { environmentId: EnvironmentId } | null,
  targetEnvironment: ReturnType<typeof useEnvironments>["environments"][number] | undefined,
  destinationPath: string,
  subdirectory: string,
) {
  const baseDirectory = getAddProjectInitialQuery( // Fork add-on(existing-checkout)
    targetEnvironment?.serverConfig?.settings.addProjectBaseDirectory, // Fork add-on(existing-checkout)
  ); // Fork add-on(existing-checkout)
  const repositoryKey = project?.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity)
    : null;
  const canFindCheckout = targetEnvironment?.serverConfig?.environment.capabilities.existingCheckout === true;
  const existingCheckout = useEnvironmentQuery(
    target && repositoryKey && canFindCheckout
      ? existingCheckoutQuery({ environmentId: target.environmentId, input: { repositoryKey } })
      : null,
  );
  const searchingCheckout = // Fork add-on(existing-checkout)
    target !== null &&
    repositoryKey !== null &&
    canFindCheckout &&
    existingCheckout.data === null &&
    existingCheckout.error === null;
  const foundRoot = existingCheckout.data?.repositoryRoot ?? null;
  const [cloneInstead, setCloneInstead] = useState(false);
  const canCheckFolder = repositoryKey !== null && targetEnvironment?.serverConfig?.environment.capabilities.existingCheckoutFolder === true;
  const [useOwnFolder, setUseOwnFolder] = useState(false);
  const addExisting = useOwnFolder || (foundRoot !== null && !cloneInstead);
  const [existingPathOverride, setExistingPathOverride] = useState<string | null>(null);
  const existingPath = existingPathOverride ?? (foundRoot ? joinSubdirectory(foundRoot, subdirectory) : useOwnFolder ? baseDirectory : "");
  const folderPath = addExisting ? existingPath : destinationPath;
  return { repositoryKey, searchingCheckout, foundRoot, setCloneInstead, canCheckFolder, useOwnFolder, setUseOwnFolder, addExisting, setExistingPathOverride, existingPath, folderPath };
}

/** Checks the folder on the other machine is a checkout of this repository. Fork add-on(existing-checkout) */
export async function checkedWorkspaceRoot(input: {
  readonly environmentId: EnvironmentId;
  readonly repositoryKey: string;
  readonly folder: string;
  readonly subdirectory: string;
  readonly repositoryName: string;
  readonly machine: string;
}): Promise<string> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    existingCheckoutQuery({
      environmentId: input.environmentId,
      input: { repositoryKey: input.repositoryKey, folder: input.folder },
    }),
    { label: "Check existing checkout", reportFailure: false, refresh: true },
  );
  if (result._tag === "Failure") throw new Error("Could not check that folder.");
  const root = result.value.repositoryRoot;
  if (root === null) {
    throw new Error(`${input.folder} is not a checkout of ${input.repositoryName} on ${input.machine}.`);
  }
  return comparablePath(root) === comparablePath(input.folder)
    ? joinSubdirectory(root, input.subdirectory)
    : input.folder;
}

function comparablePath(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  return /^[a-z]:|\\/i.test(trimmed) ? trimmed.replaceAll("\\", "/").toLowerCase() : trimmed;
}

/** Fork add-on(existing-checkout): uses the found folder's own separator, since the other machine may be Windows. */
export function joinSubdirectory(root: string, subdirectory: string) {
  if (!subdirectory) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${subdirectory.replaceAll("/", separator)}`;
}
