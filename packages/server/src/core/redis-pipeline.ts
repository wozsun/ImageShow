type RedisPipelineResult = [Error | null, unknown];

type RedisPipeline = {
  exec(): Promise<RedisPipelineResult[] | null>;
};

export async function execRedisPipeline(pipeline: RedisPipeline) {
  const results = await pipeline.exec();
  if (!results) throw new Error("Redis pipeline returned no results");
  const failed = results.find(([error]) => error);
  if (failed?.[0]) throw failed[0];
  return results;
}
