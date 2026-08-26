export type IngestionActivationKind =
  | "workflow"
  | "files"
  | "urls"
  | "jsonl"
  | "weibo";

export type IngestionActivation = {
  sequence: number;
  kind: IngestionActivationKind;
  opener: HTMLElement;
};
