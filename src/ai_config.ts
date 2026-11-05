export type GeminiConfig = {
  key: string;
  model: string;
  budget: number;
  reserve: number;
  inputRate: number;
  outputRate: number;
  embeddingRate: number;
  embeddingModel: string;
};

const nonNegativeNumber = (environment: NodeJS.ProcessEnv, key: string) => {
  const raw = environment[key];
  if (raw == null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

export function getGeminiConfig(environment: NodeJS.ProcessEnv = process.env): GeminiConfig | null {
  const key = environment.GEMINI_API_KEY;
  if (!key || environment.GEMINI_CREDITS_CONFIRMED !== 'true' || environment.GEMINI_SPEND_CAP_CONFIGURED !== 'true') return null;
  const budget = nonNegativeNumber(environment, 'GEMINI_BUDGET_USD');
  const reserve = nonNegativeNumber(environment, 'GEMINI_BUDGET_RESERVE_USD');
  const inputRate = nonNegativeNumber(environment, 'GEMINI_INPUT_USD_PER_MILLION');
  const outputRate = nonNegativeNumber(environment, 'GEMINI_OUTPUT_USD_PER_MILLION');
  const embeddingRate = nonNegativeNumber(environment, 'GEMINI_EMBEDDING_USD_PER_MILLION');
  if (budget === null || reserve === null || inputRate === null || outputRate === null || embeddingRate === null || budget <= reserve) return null;
  return {
    key,
    model: environment.GEMINI_MODEL || 'gemini-2.5-flash',
    budget,
    reserve,
    inputRate,
    outputRate,
    embeddingRate,
    embeddingModel: environment.GEMINI_EMBEDDING_MODEL || 'models/gemini-embedding-001',
  };
}
