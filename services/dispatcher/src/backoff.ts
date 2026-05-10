// Exponential backoff in seconds: min(2^attempts, 3600) with jitter [0.5, 1.5).
export const backoffSeconds = (attempts: number): number => {
  const base = Math.min(2 ** attempts, 3_600);
  const jitter = 0.5 + Math.random();
  return Math.max(1, Math.floor(base * jitter));
};
