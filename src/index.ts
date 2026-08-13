/**
 * Package entry (SPEC §8). Re-exports the workflow authoring API so that
 * `declare module "decompi"` augmentation (adapters adding `WorkItemKindMap`
 * / `WorkflowHelpers` members) attaches via the package `exports`
 * self-reference in package.json — without this file, augmentation fails with
 * TS2664.
 */
export * from "./workflow/helpers.js";
export * from "./workflow/types.js";
