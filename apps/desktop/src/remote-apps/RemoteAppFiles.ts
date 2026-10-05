/**
 * Filename helpers for files the remote-app shell writes or proposes: saved
 * downloads, saved selections, and imported chat exports.
 */

const MAX_FILENAME_LENGTH = 180;

/** A filename safe on every desktop platform; control and reserved characters become "-". */
export const safeFilename = (filename: string, fallback = "download"): string => {
  const normalized = [...filename]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? "-" : character;
    })
    .join("")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FILENAME_LENGTH)
    // Windows drops trailing dots and spaces.
    .replace(/[. ]+$/, "");
  return normalized.length > 0 ? normalized : fallback;
};

/**
 * `stem` + `extension`, numbered " (2)", " (3)"... until it is not in
 * `taken`, compared case-insensitively since macOS and Windows are. The
 * chosen name is added to `taken`.
 */
export const claimUniqueFilename = (
  stem: string,
  extension: string,
  taken: Set<string>,
): string => {
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? `${stem}${extension}` : `${stem} (${index})${extension}`;
    const key = name.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    return name;
  }
};
