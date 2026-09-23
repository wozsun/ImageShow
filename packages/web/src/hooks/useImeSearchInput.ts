import { useState, type ChangeEvent, type CompositionEvent, type FocusEvent } from "react";
import { useImeInputSession } from "./useImeInputSession.js";

/** Keep IME preedit text visible without publishing it as a search query. */
export function useImeSearchInput(query: string, publish: (value: string) => void) {
  const [text, setText] = useState(query);
  const session = useImeInputSession(query);
  const commit = (value: string) => {
    setText(value);
    publish(value);
  };
  return {
    text,
    reset(value = "") {
      session.settleEditing(value);
      commit(value);
    },
    inputProps: {
      value: text,
      onFocus: () => session.beginEditing(),
      onCompositionStart: () => session.beginComposition(),
      onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => {
        if (session.endComposition(event.currentTarget)) commit(event.currentTarget.value);
        else setText(event.currentTarget.value);
      },
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        const composing = session.isComposing((event.nativeEvent as InputEvent).isComposing);
        // A reset can settle the session while the input keeps focus. A new
        // ordinary input resumes editing; late events after blur remain ignored.
        if (!composing && event.currentTarget.ownerDocument.activeElement === event.currentTarget) session.beginEditing();
        if (!session.acceptInput(event.currentTarget)) return;
        const value = event.currentTarget.value;
        setText(value);
        if (!composing) publish(value);
      },
      onBlur: (event: FocusEvent<HTMLInputElement>) => {
        // An unfinished composition is not a confirmed query. Ignore a late
        // compositionend after blur, using the existing IME session guard.
        session.settleEditing(query);
        event.currentTarget.value = query;
        setText(query);
      }
    }
  };
}
