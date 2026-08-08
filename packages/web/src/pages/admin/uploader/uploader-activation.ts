export type UploaderActivationKind =
  | "workflow"
  | "files"
  | "urls"
  | "jsonl"
  | "weibo";

export type UploaderActivation = {
  sequence: number;
  kind: UploaderActivationKind;
  opener: HTMLElement;
};
