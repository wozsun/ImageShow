export type ApiErrorResponseDto = {
  ok: false;
  code: string;
  error: string;
  details?: unknown;
};

/**
 * 请求校验失败（code 为 validation_error）时 details.issues 的每一项：field 为出错字段的完整
 * 路径（点分，数组下标同样以段表示），message 为该字段的第一条问题。
 */
export type ApiValidationIssueDto = {
  field: string;
  message: string;
};

export type ApiSuccessResponseDto<T extends Record<string, unknown>> = {
  ok: true;
} & T;
