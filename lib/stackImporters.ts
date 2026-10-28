export type StackImportMediaType = "movie" | "tv" | "anime" | "manga" | "book" | "game";
export type StackImportStatus = "completed" | "in_progress" | "planned" | "dropped";
export type StackImportSource = "paste" | "myanimelist" | "letterboxd";
export type StackImportTypeHint = "exact" | "tv_or_anime" | "manga_or_book";

export type StackImportCandidate = {
  id: string;
  source: StackImportSource;
  sourceLabel: string;
  externalId?: string;
  title: string;
  originalTitle?: string;
  year?: number;
  type: StackImportMediaType;
  typeHint?: StackImportTypeHint;
  status: StackImportStatus;
  rating?: number;
  dateFinished?: string;
  notes?: string;
  tags: string[];
  rewatchCount?: number;
  inTheaters?: boolean;
  progressCur?: number;
  progressTotal?: number;
  runtime?: number;
  posterUrl?: string;
  tmdbId?: number;
  tmdbType?: "movie" | "tv";
  igdbId?: number;
  anilistId?: number;
  anilistType?: "ANIME" | "MANGA";
  importYearMonth?: string;
  selected: boolean;
  matchConfidence?: number;
  matchLabel?: string;
  warnings?: string[];
};

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function uid(prefix: string, index: number) {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${suffix}`;
}

function cleanNumber(value: unknown) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : undefined;
}

function cleanPositiveInt(value: unknown) {
  const n = Math.floor(Number(String(value ?? "").trim()));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function cleanNonNegativeInt(value: unknown) {
  const n = Math.floor(Number(String(value ?? "").trim()));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function cleanDate(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "0000-00-00") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}

function uniqueStrings(values: Array<string | undefined | null>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function splitTags(value: unknown) {
  return uniqueStrings(
    String(value ?? "")
      .split(/[,;|]/g)
      .map((tag) => tag.trim())
  );
}

function normalizeTitle(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mergeNotes(...values: Array<string | undefined>) {
  return uniqueStrings(values).join("\n");
}

function mergeCandidates(candidates: StackImportCandidate[]) {
  const byKey = new Map<string, StackImportCandidate>();

  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.type}:${normalizeTitle(candidate.title)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }

    const mergedMonths = uniqueStrings([
      existing.importYearMonth,
      candidate.importYearMonth,
    ]);

    byKey.set(key, {
      ...existing,
      rating: candidate.rating ?? existing.rating,
      dateFinished: candidate.dateFinished ?? existing.dateFinished,
      notes: mergeNotes(existing.notes, candidate.notes),
      tags: uniqueStrings([...(existing.tags ?? []), ...(candidate.tags ?? [])]),
      rewatchCount: Math.max(existing.rewatchCount ?? 0, candidate.rewatchCount ?? 0) || undefined,
      inTheaters: !!existing.inTheaters || !!candidate.inTheaters,
      importYearMonth: mergedMonths.join(", "),
      warnings: uniqueStrings([
        ...(existing.warnings ?? []),
        ...(candidate.warnings ?? []),
        "Repeated title in the pasted list was merged into one Stack entry.",
      ]),
    });
  }

  return Array.from(byKey.values());
}

function parseRatingFromAnnotations(annotations: string[]) {
  for (const annotation of annotations) {
    const ten = annotation.match(/(?:^|\s)(10|[0-9](?:\.\d+)?)\s*\/\s*10\b/i);
    if (ten) {
      const value = Number(ten[1]);
      if (Number.isFinite(value)) return Math.max(0, Math.min(10, value));
    }
  }

  for (const annotation of annotations) {
    const standalone = annotation.trim().match(/^(10|[0-9](?:\.\d+)?)$/);
    if (standalone) {
      const value = Number(standalone[1]);
      if (Number.isFinite(value)) return Math.max(0, Math.min(10, value));
    }
  }

  return undefined;
}

function parsePasteEntry(
  rawLine: string,
  section: "movies" | "tv" | "manga_books" | "games",
  year: number,
  month: number,
  index: number
): StackImportCandidate | null {
  const line = rawLine.replace(/^[-*•]\s*/, "").trim();
  if (!line) return null;

  const annotations: string[] = [];
  let title = line;
  let guard = 0;
  while (guard < 12) {
    guard += 1;
    const match = title.match(/\s*\(([^()]*)\)\s*$/);
    if (!match) break;
    annotations.unshift(match[1].trim());
    title = title.slice(0, match.index).trim();
  }

  if (!title) title = line;

  const rating = parseRatingFromAnnotations(annotations);
  const annotationText = annotations.join(" | ");
  const isRewatch = /\brewatch\b/i.test(annotationText);
  const inTheaters = /\bin\s+theaters?\b/i.test(annotationText);

  const ignoredAnnotationPatterns = [
    /(?:^|\s)(?:10|[0-9](?:\.\d+)?)\s*\/\s*10\b/i,
    /^(?:10|[0-9](?:\.\d+)?)$/,
    /\brewatch\b/i,
    /\bin\s+theaters?\b/i,
  ];

  const noteAnnotations = annotations.filter(
    (annotation) => !ignoredAnnotationPatterns.some((pattern) => pattern.test(annotation))
  );

  let type: StackImportMediaType = "movie";
  let typeHint: StackImportTypeHint = "exact";
  let status: StackImportStatus = "completed";

  if (section === "tv") {
    type = "tv";
    typeHint = "tv_or_anime";
  } else if (section === "manga_books") {
    type = "book";
    typeHint = "manga_or_book";
  } else if (section === "games") {
    type = "game";
    status = "in_progress";
  }

  const monthName = Object.keys(MONTHS).find((name) => MONTHS[name] === month) ?? "month";
  const sourceMonth = `${monthName.charAt(0).toUpperCase()}${monthName.slice(1)} ${year}`;

  return {
    id: uid("paste", index),
    source: "paste",
    sourceLabel: "Smart Paste",
    title,
    originalTitle: line,
    type,
    typeHint,
    status,
    rating,
    notes: mergeNotes(
      noteAnnotations.length ? noteAnnotations.join("; ") : undefined,
      `Imported from ${sourceMonth} yearly log.`
    ),
    tags: [],
    rewatchCount: isRewatch ? 1 : undefined,
    inTheaters: inTheaters || undefined,
    importYearMonth: `${year}-${String(month).padStart(2, "0")}`,
    selected: true,
  };
}

export function parseSmartPaste(text: string, defaultYear = new Date().getFullYear()) {
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const firstExplicitYearIndex = lines.findIndex((line) => /\((20\d{2})\)\s*-?\s*$/.test(line));
  const firstMonthIndex = lines.findIndex((line) => {
    const key = line.replace(/-+\s*$/, "").trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(MONTHS, key);
  });

  let initialYear = defaultYear;
  if (firstExplicitYearIndex > firstMonthIndex && firstMonthIndex >= 0) {
    const match = lines[firstExplicitYearIndex].match(/\((20\d{2})\)/);
    if (match) initialYear = Number(match[1]) - 1;
  }

  let year = initialYear;
  let month = 0;
  let section: "movies" | "tv" | "manga_books" | "games" | null = null;
  const candidates: StackImportCandidate[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const explicitYear = line.match(/\((20\d{2})\)\s*-?\s*$/);
    if (explicitYear) {
      year = Number(explicitYear[1]);
      month = 0;
      section = null;
      continue;
    }

    const monthKey = line.replace(/-+\s*$/, "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MONTHS, monthKey)) {
      month = MONTHS[monthKey];
      section = null;
      continue;
    }

    const normalized = line.toLowerCase().replace(/[:\-]+$/, "").trim();
    if (normalized === "movies") {
      section = "movies";
      continue;
    }
    if (normalized === "tv shows/anime" || normalized === "tv shows" || normalized === "anime") {
      section = "tv";
      continue;
    }
    if (normalized === "manga/books" || normalized === "manga" || normalized === "books") {
      section = "manga_books";
      continue;
    }
    if (normalized === "games played" || normalized === "games") {
      section = "games";
      continue;
    }

    if (!month || !section) continue;
    const candidate = parsePasteEntry(line, section, year, month, index);
    if (candidate) candidates.push(candidate);
  }

  return mergeCandidates(candidates);
}

function malStatusToStack(value: string): StackImportStatus {
  const status = value.trim().toLowerCase().replace(/[-_]/g, " ");
  if (status.includes("complete")) return "completed";
  if (status.includes("drop")) return "dropped";
  if (status.includes("plan")) return "planned";
  if (status.includes("watch") || status.includes("read") || status.includes("hold")) {
    return "in_progress";
  }
  return "planned";
}

function xmlText(element: Element, names: string[]) {
  for (const name of names) {
    const found = element.getElementsByTagName(name)?.[0];
    const value = found?.textContent?.trim();
    if (value) return value;
  }
  return "";
}

export function parseMyAnimeListXml(xmlTextValue: string) {
  if (typeof DOMParser === "undefined") {
    throw new Error("This browser cannot parse XML imports.");
  }

  const doc = new DOMParser().parseFromString(xmlTextValue, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("The MyAnimeList file could not be parsed as XML.");
  }

  const animeNodes = Array.from(doc.getElementsByTagName("anime"));
  const mangaNodes = Array.from(doc.getElementsByTagName("manga"));
  const candidates: StackImportCandidate[] = [];

  animeNodes.forEach((node, index) => {
    const title = xmlText(node, ["series_title"]);
    if (!title) return;
    const malId = xmlText(node, ["series_animedb_id"]);
    const total = cleanPositiveInt(xmlText(node, ["series_episodes"]));
    const progress = cleanNonNegativeInt(xmlText(node, ["my_watched_episodes"]));
    const score = cleanNumber(xmlText(node, ["my_score"]));
    const status = malStatusToStack(xmlText(node, ["my_status"]));
    const finishDate = cleanDate(xmlText(node, ["my_finish_date"]));
    const tags = splitTags(xmlText(node, ["my_tags"]));
    const comments = xmlText(node, ["my_comments"]);
    const rewatches = cleanNonNegativeInt(xmlText(node, ["my_times_watched"]));

    candidates.push({
      id: uid("mal-anime", index),
      source: "myanimelist",
      sourceLabel: "MyAnimeList Anime",
      externalId: malId ? `anime:${malId}` : undefined,
      title,
      type: "anime",
      typeHint: "exact",
      status,
      rating: typeof score === "number" && score > 0 ? Math.min(10, score) : undefined,
      dateFinished: finishDate,
      notes: comments || undefined,
      tags,
      rewatchCount: rewatches && rewatches > 0 ? rewatches : undefined,
      progressCur: progress,
      progressTotal: total,
      selected: true,
    });
  });

  mangaNodes.forEach((node, index) => {
    const title = xmlText(node, ["manga_title", "series_title"]);
    if (!title) return;
    const malId = xmlText(node, ["manga_mangadb_id", "series_mangadb_id"]);
    const totalChapters = cleanPositiveInt(xmlText(node, ["manga_chapters", "series_chapters"]));
    const progressChapters = cleanNonNegativeInt(xmlText(node, ["my_read_chapters"]));
    const score = cleanNumber(xmlText(node, ["my_score"]));
    const status = malStatusToStack(xmlText(node, ["my_status"]));
    const finishDate = cleanDate(xmlText(node, ["my_finish_date"]));
    const tags = splitTags(xmlText(node, ["my_tags"]));
    const comments = xmlText(node, ["my_comments"]);
    const rereads = cleanNonNegativeInt(xmlText(node, ["my_times_read"]));

    candidates.push({
      id: uid("mal-manga", index),
      source: "myanimelist",
      sourceLabel: "MyAnimeList Manga",
      externalId: malId ? `manga:${malId}` : undefined,
      title,
      type: "manga",
      typeHint: "exact",
      status,
      rating: typeof score === "number" && score > 0 ? Math.min(10, score) : undefined,
      dateFinished: finishDate,
      notes: comments || undefined,
      tags,
      rewatchCount: rereads && rereads > 0 ? rereads : undefined,
      progressCur: progressChapters,
      progressTotal: totalChapters,
      selected: true,
    });
  });

  if (!candidates.length) {
    throw new Error("No anime or manga entries were found in this MyAnimeList XML file.");
  }

  return candidates;
}

async function streamToText(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text();
}

export async function readMyAnimeListFile(file: File) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".gz") || name.endsWith(".xml.gz")) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("This browser cannot open .gz directly. Unzip the MAL export and select the .xml file instead.");
    }
    const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
    return streamToText(stream);
  }
  return file.text();
}

export function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

function normalizeHeader(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function parseLetterboxdCsv(text: string, fileName: string, offset = 0) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [] as StackImportCandidate[];
  const headers = rows[0].map(normalizeHeader);
  const indexOf = (...names: string[]) => {
    for (const name of names) {
      const idx = headers.indexOf(normalizeHeader(name));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const valueAt = (row: string[], index: number) => (index >= 0 ? String(row[index] ?? "").trim() : "");

  const titleIndex = indexOf("Name", "Title");
  const yearIndex = indexOf("Year");
  const ratingIndex = indexOf("Rating", "Rating10");
  const watchedDateIndex = indexOf("Watched Date", "WatchedDate");
  const rewatchIndex = indexOf("Rewatch");
  const tagsIndex = indexOf("Tags");
  const reviewIndex = indexOf("Review");
  const uriIndex = indexOf("Letterboxd URI", "LetterboxdURI", "URI");

  const lowerName = fileName.toLowerCase();
  const isWatchlist = lowerName.includes("watchlist");
  const isDiary = lowerName.includes("diary");
  const output: StackImportCandidate[] = [];

  rows.slice(1).forEach((row, rowIndex) => {
    const title = valueAt(row, titleIndex);
    if (!title) return;
    const year = cleanPositiveInt(valueAt(row, yearIndex));
    const rawRating = cleanNumber(valueAt(row, ratingIndex));
    const rating = typeof rawRating === "number" && rawRating > 0
      ? Math.max(0, Math.min(10, rawRating <= 5 ? rawRating * 2 : rawRating))
      : undefined;
    const watchedDate = cleanDate(valueAt(row, watchedDateIndex));
    const rewatchValue = valueAt(row, rewatchIndex).toLowerCase();
    const rewatch = ["true", "yes", "1", "y"].includes(rewatchValue);
    const tags = splitTags(valueAt(row, tagsIndex));
    const review = valueAt(row, reviewIndex);
    const uri = valueAt(row, uriIndex);

    output.push({
      id: uid("letterboxd", offset + rowIndex),
      source: "letterboxd",
      sourceLabel: `Letterboxd ${fileName}`,
      externalId: uri || (year ? `${title}:${year}` : title),
      title,
      year,
      type: "movie",
      typeHint: "exact",
      status: isWatchlist ? "planned" : "completed",
      rating,
      dateFinished: isDiary ? watchedDate : undefined,
      notes: review || undefined,
      tags,
      rewatchCount: rewatch ? 1 : undefined,
      selected: true,
    });
  });

  return output;
}

function mergeLetterboxdCandidates(candidates: StackImportCandidate[]) {
  const byKey = new Map<string, StackImportCandidate>();
  for (const candidate of candidates) {
    const key = `${normalizeTitle(candidate.title)}:${candidate.year ?? ""}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }

    const completed = existing.status === "completed" || candidate.status === "completed";
    const dateA = existing.dateFinished ?? "";
    const dateB = candidate.dateFinished ?? "";
    const latestDate = [dateA, dateB].filter(Boolean).sort().at(-1);

    byKey.set(key, {
      ...existing,
      sourceLabel: "Letterboxd export",
      externalId: existing.externalId || candidate.externalId,
      status: completed ? "completed" : "planned",
      rating: candidate.rating ?? existing.rating,
      dateFinished: latestDate || undefined,
      notes: mergeNotes(existing.notes, candidate.notes),
      tags: uniqueStrings([...(existing.tags ?? []), ...(candidate.tags ?? [])]),
      rewatchCount: Math.max(
        candidate.rewatchCount ?? 0,
        (existing.rewatchCount ?? 0) +
          (existing.dateFinished && candidate.dateFinished && existing.dateFinished !== candidate.dateFinished ? 1 : 0)
      ) || undefined,
      warnings: uniqueStrings([...(existing.warnings ?? []), ...(candidate.warnings ?? [])]),
    });
  }
  return Array.from(byKey.values());
}

function findEocd(view: DataView) {
  const min = Math.max(0, view.byteLength - 65557);
  for (let offset = view.byteLength - 22; offset >= min; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

async function inflateRaw(bytes: Uint8Array) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress ZIP entries. Extract the Letterboxd ZIP and select the CSV files instead.");
  }

  // BlobPart requires an ArrayBuffer-backed value. A Uint8Array can be typed
  // against ArrayBufferLike (which also includes SharedArrayBuffer), so copy the
  // exact byte range into a plain ArrayBuffer before constructing the Blob.
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;

  const stream = new Blob([arrayBuffer])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extractCsvTextsFromZip(file: File) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error("Could not read the Letterboxd ZIP file.");

  const entryCount = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8");
  const files: Array<{ name: string; text: string }> = [];
  let ptr = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (ptr + 46 > view.byteLength || view.getUint32(ptr, true) !== 0x02014b50) break;
    const compression = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLength = view.getUint16(ptr + 28, true);
    const extraLength = view.getUint16(ptr + 30, true);
    const commentLength = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const nameBytes = new Uint8Array(buffer, ptr + 46, nameLength);
    const name = decoder.decode(nameBytes);

    if (name.toLowerCase().endsWith(".csv") && uncompressedSize <= 20 * 1024 * 1024) {
      if (localOffset + 30 <= view.byteLength && view.getUint32(localOffset, true) === 0x04034b50) {
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const dataEnd = dataStart + compressedSize;
        if (dataStart >= 0 && dataEnd <= view.byteLength) {
          const compressed = new Uint8Array(buffer.slice(dataStart, dataEnd));
          let raw: Uint8Array;
          if (compression === 0) raw = compressed;
          else if (compression === 8) raw = await inflateRaw(compressed);
          else {
            ptr += 46 + nameLength + extraLength + commentLength;
            continue;
          }
          files.push({ name, text: decoder.decode(raw) });
        }
      }
    }

    ptr += 46 + nameLength + extraLength + commentLength;
  }

  if (!files.length) {
    throw new Error("No readable CSV files were found inside the Letterboxd ZIP.");
  }
  return files;
}

export async function parseLetterboxdFiles(inputFiles: File[]) {
  const csvTexts: Array<{ name: string; text: string }> = [];
  for (const file of inputFiles) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".zip")) {
      csvTexts.push(...(await extractCsvTextsFromZip(file)));
    } else if (name.endsWith(".csv")) {
      csvTexts.push({ name: file.name, text: await file.text() });
    }
  }

  if (!csvTexts.length) {
    throw new Error("Choose a Letterboxd export ZIP or one or more Letterboxd CSV files.");
  }

  const candidates: StackImportCandidate[] = [];
  let offset = 0;
  for (const csv of csvTexts) {
    const parsed = parseLetterboxdCsv(csv.text, csv.name, offset);
    candidates.push(...parsed);
    offset += parsed.length + 100;
  }

  const merged = mergeLetterboxdCandidates(candidates);
  if (!merged.length) throw new Error("No Letterboxd movie rows were found in the selected export.");
  return merged;
}
