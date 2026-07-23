export function isMissingFileError(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function isS3NotFound(error: unknown) {
  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return candidate?.$metadata?.httpStatusCode === 404
    || candidate?.name === "NoSuchKey"
    || candidate?.name === "NotFound"
    || candidate?.Code === "NoSuchKey";
}

export function isWebdavNotFoundStatus(status: number) {
  return status === 404;
}
