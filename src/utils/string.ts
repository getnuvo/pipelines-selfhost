// Simple quote escape helper for embedding values safely inside double quotes
export const serializationConfigValue = (val: string | number | undefined) => {
  if (val === undefined) return '';
  return String(val).replace(/"/g, '\\"');
};
