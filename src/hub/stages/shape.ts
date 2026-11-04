import type { Middleware } from '../executor.js';
import { dataResult } from '../result.js';
import { shapeData } from '../shaping.js';

/** Applies `fields`, drops empty values and enforces the result size budget (see `shaping.ts`). */
export function shapeStage(deps: { maxResultTokens: number }): Middleware {
  return async (call, next) => {
    const result = await next();
    if (result.isError || result.data === undefined) return result;
    const allowed = call.action.response?.fields;
    const fields = call.options.fields?.filter((f) => !allowed || allowed.includes(f.split('.')[0]!));
    const shaped = shapeData(result.data, {
      maxTokens: call.action.response?.maxTokens ?? deps.maxResultTokens,
      ...(fields?.length ? { fields } : {}),
    });
    if (shaped.truncated) call.audit.truncated = true;
    return dataResult(shaped.data);
  };
}
