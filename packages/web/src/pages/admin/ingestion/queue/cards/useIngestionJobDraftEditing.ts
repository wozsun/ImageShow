import { useCallback, useEffect, useRef, useState } from "react";
import {
  type IngestionDraftUrlField,
  normalizeIngestionDraftUrl
} from "@imageshow/shared/browser";
import type {
  ImageDraftDeferredEditing,
  ImageDraftDeferredField
} from "../../../../../components/form/ImageDraftFields.js";
import type { ImageDraft, IngestionJob } from "../../../../../lib/types.js";
import { ingestionJobAttributesEditable } from "../model/ingestion-attribute-policy.js";

type DeferredPlainField = keyof ImageDraftDeferredEditing["values"];

type IngestionDraftEditSession = {
  field: ImageDraftDeferredField;
  incarnation: string;
  initialValue: string;
  value: string;
};

function isDeferredPlainField(
  field: ImageDraftDeferredField
): field is DeferredPlainField {
  return field !== "theme" && field !== "author";
}

function isIngestionDraftUrlField(
  field: ImageDraftDeferredField
): field is IngestionDraftUrlField {
  return field === "original" || field === "source";
}

function reportInvalidDraftUrl(field: IngestionDraftUrlField) {
  const label = field === "original" ? "原图" : "来源";
  console.info(`[ImageShow] 内容接入草稿${label} URL 格式无效，未保存`);
}

export function useIngestionJobDraftEditing({
  job,
  busy,
  onPatch
}: {
  job: IngestionJob;
  busy: boolean;
  onPatch: (job: IngestionJob, patch: Partial<ImageDraft>) => void;
}) {
  const jobRef = useRef(job);
  jobRef.current = job;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onPatchRef = useRef(onPatch);
  onPatchRef.current = onPatch;
  const [session, setSession] = useState<IngestionDraftEditSession | null>(null);
  const sessionRef = useRef(session);

  const replaceSession = useCallback((next: IngestionDraftEditSession | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const currentSessionJob = useCallback((edit: IngestionDraftEditSession) => {
    const current = jobRef.current;
    if (
      busyRef.current
      || !ingestionJobAttributesEditable(current)
      || edit.incarnation !== current.attemptKey
    ) return null;
    return current;
  }, []);

  const focus = useCallback((field: ImageDraftDeferredField) => {
    const current = jobRef.current;
    if (busyRef.current || !ingestionJobAttributesEditable(current)) return;
    const value = current.draft[field];
    replaceSession({
      field,
      incarnation: current.attemptKey,
      initialValue: value,
      value
    });
  }, [replaceSession]);

  const changeText = useCallback((field: DeferredPlainField, value: string) => {
    const current = sessionRef.current;
    if (
      !current
      || current.field !== field
      || !currentSessionJob(current)
    ) return;
    replaceSession({ ...current, value });
  }, [currentSessionJob, replaceSession]);

  const commit = useCallback((field: ImageDraftDeferredField, value: string) => {
    const edit = sessionRef.current;
    if (!edit || edit.field !== field) return;
    const current = currentSessionJob(edit);
    if (
      !current
      || value === edit.initialValue
      || value === current.draft[field]
    ) return;
    if (
      isIngestionDraftUrlField(field)
      && normalizeIngestionDraftUrl(field, value) === null
    ) {
      reportInvalidDraftUrl(field);
      return;
    }
    onPatchRef.current(current, { [field]: value } as Partial<ImageDraft>);
  }, [currentSessionJob]);

  const blur = useCallback((field: ImageDraftDeferredField) => {
    const edit = sessionRef.current;
    if (!edit || edit.field !== field) return;
    if (isDeferredPlainField(field)) commit(field, edit.value);
    if (sessionRef.current === edit) replaceSession(null);
  }, [commit, replaceSession]);

  const editable = ingestionJobAttributesEditable(job) && !busy;
  const currentSession = session
    && editable
    && session.incarnation === job.attemptKey
    ? session
    : null;
  useEffect(() => {
    const current = sessionRef.current;
    if (
      current
      && (!editable || current.incarnation !== job.attemptKey)
    ) replaceSession(null);
  }, [editable, job.attemptKey, replaceSession]);
  const textValue = (field: DeferredPlainField) => (
    currentSession?.field === field ? currentSession.value : job.draft[field]
  );
  const deferredEditing: ImageDraftDeferredEditing = {
    values: {
      title: textValue("title"),
      original: textValue("original"),
      source: textValue("source"),
      description: textValue("description")
    },
    onFocus: focus,
    onTextChange: changeText,
    onCommit: commit,
    onBlur: blur
  };
  return {
    deferredEditing,
    title: deferredEditing.values.title
  };
}
