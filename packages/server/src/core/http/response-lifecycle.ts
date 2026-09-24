/**
 * Keeps request-scoped resources alive until a streamed response finishes.
 * Cleanup runs exactly once for empty bodies, EOF, read failures or consumer
 * cancellation.
 */
export function responseWithCleanup(
  response: Response,
  cleanup: () => void
) {
  if (!response.body) {
    cleanup();
    return response;
  }

  const reader = response.body.getReader();
  let cleaned = false;
  const cleanupOnce = () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanupOnce();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        cleanupOnce();
        controller.error(error);
      }
    },
    cancel(reason) {
      cleanupOnce();
      return reader.cancel(reason);
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}
