export function httpsOrigin(value: string) {
  if (!URL.canParse(value)) return null;
  const { origin, protocol } = new URL(value);
  return protocol === "https:" && (value === origin || value === `${origin}/`) ? origin : null;
}
