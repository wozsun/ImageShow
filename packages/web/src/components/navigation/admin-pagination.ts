export function parseAdminPaginationPage(value: string, totalPages: number) {
  if (!/^\d+$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 && page <= totalPages
    ? page
    : null;
}

export function resolveAdminPaginationCommit({
  value,
  page,
  totalPages,
  submittedPage
}: {
  value: string;
  page: number;
  totalPages: number;
  submittedPage: number | null;
}) {
  const targetPage = parseAdminPaginationPage(value, totalPages);
  if (targetPage === null) {
    return {
      value,
      invalid: true,
      submittedPage: null,
      targetPage: null
    };
  }

  const normalizedValue = String(targetPage);
  if (targetPage === page) {
    return {
      value: normalizedValue,
      invalid: false,
      submittedPage: null,
      targetPage: null
    };
  }
  if (targetPage === submittedPage) {
    return {
      value: normalizedValue,
      invalid: false,
      submittedPage,
      targetPage: null
    };
  }
  return {
    value: normalizedValue,
    invalid: false,
    submittedPage: targetPage,
    targetPage
  };
}

export function releaseAdminPaginationSubmission(
  wasDisabled: boolean,
  disabled: boolean,
  submittedPage: number | null
) {
  return wasDisabled && !disabled ? null : submittedPage;
}

export function shouldCommitAdminPaginationInput(
  key: string,
  isComposing: boolean,
  keyCode: number
) {
  return key === "Enter" && !isComposing && keyCode !== 229;
}

export function shouldPreserveAdminPaginationInputFocus(
  pointerButton: number,
  inputFocused: boolean
) {
  return pointerButton === 0 && inputFocused;
}
