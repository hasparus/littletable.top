export function fileFromDataUrl(url: string, name: string): File {
  const comma = url.indexOf(",");
  if (comma === -1) throw new Error("board: invalid data URL");
  const header = url.slice(5, comma);
  const type = header.split(";")[0] || "application/octet-stream";
  const data = url.slice(comma + 1);
  if (!header.endsWith(";base64")) {
    return new File([decodeURIComponent(data)], name || "image", { type });
  }
  const decoded = atob(data);
  const bytes = new Uint8Array(decoded.length);
  for (let at = 0; at < decoded.length; at++) bytes[at] = decoded.codePointAt(at)!;
  return new File([bytes], name || "image", { type });
}
