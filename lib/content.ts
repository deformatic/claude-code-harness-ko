import fs from "node:fs";
import path from "node:path";
import GithubSlugger from "github-slugger";

export type TocItem = {
  id: string;
  text: string;
  depth: 2 | 3;
};

export type DocSection = "preface" | "part" | "appendix" | "meta";

export type DocumentItem = {
  slug: string;
  title: string;
  section: DocSection;
  order: number;
  partLabel: string | null;
  sourcePath: string;
  markdownBody: string;
  toc: TocItem[];
  prevSlug: string | null;
  nextSlug: string | null;
  externalSourceUrl: string | null;
  summary: string;
};

const ROOT = process.cwd();
const CONTENT_DIR = path.join(ROOT, "ko");
const TOC_FILE = path.join(CONTENT_DIR, "01-map-toc.md");
const ORIGINAL_SOURCE_BASE = "https://zhanghandong.github.io/harness-engineering-from-cc-to-ai-coding";
const VISUALIZATION_BASE = "https://ccunpacked.dev";

const DOC_LINK_RE =
  /https:\/\/zhanghandong\.github\.io\/harness-engineering-from-cc-to-ai-coding\/en\/([^)#\s]+)(?:#[^)]+)?/g;
const LOCAL_ASSET_RE = /^\.\/assets\//;

type TocRecord = {
  slug: string;
  order: number;
  title: string;
  externalUrl: string | null;
  partLabel: string | null;
};

function getMarkdownFiles(): string[] {
  return fs
    .readdirSync(CONTENT_DIR)
    .filter((file) => file.endsWith(".md") && file !== "01-map-toc.md")
    .sort();
}

function parseOrderMap(): Map<string, TocRecord> {
  const raw = fs.readFileSync(TOC_FILE, "utf8");
  const map = new Map<string, TocRecord>();
  let currentPart: string | null = null;
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const partMatch = line.match(/^\d+\.\s+(파트 [IVX]+: .+)$/);
    if (partMatch) {
      currentPart = partMatch[1];
      continue;
    }

    const docMatch = line.match(
      /^(\d+)\.\s+\[(?:\*\*\d+\.\*\*\s+)?(.+?)\]\((https:\/\/zhanghandong\.github\.io\/harness-engineering-from-cc-to-ai-coding\/en\/([^)]+))\)/
    );
    if (docMatch) {
      const order = Number(docMatch[1]);
      const title = docMatch[2];
      const externalUrl = docMatch[3];
      const externalPath = docMatch[4];
      const slug = externalPathToSlug(externalPath);
      map.set(slug, { slug, order, title, externalUrl, partLabel: currentPart });
    }
  }

  return map;
}

function externalPathToSlug(externalPath: string): string {
  if (externalPath === "preface.html") {
    return "preface";
  }

  if (externalPath.startsWith("part")) {
    const match = externalPath.match(/part\d+\/(ch[0-9]+[a-z]?)\.html/);
    if (match) {
      const part = externalPath.match(/part(\d+)/)?.[1];
      return `part${part}-${match[1]}`;
    }
  }

  if (externalPath.startsWith("appendix/")) {
    const appendix = externalPath.replace("appendix/", "").replace(".html", "");
    return `appendix-${appendix}`;
  }

  return externalPath.replace(".html", "").replaceAll("/", "-");
}

function inferSection(slug: string): DocSection {
  if (slug === "preface") return "preface";
  if (slug.startsWith("appendix-")) return "appendix";
  if (slug.startsWith("part")) return "part";
  return "meta";
}

function stripHeaderAnchor(text: string): string {
  return text
    .replace(/<a[^>]*class="header"[^>]*>/g, "")
    .replace(/<\/a>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return stripHeaderAnchor(match?.[1] || "Untitled");
}

function buildToc(markdown: string): TocItem[] {
  const slugger = new GithubSlugger();
  const toc: TocItem[] = [];
  const lines = markdown.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^(##|###)\s+(.+)$/);
    if (!match) continue;
    const depth = match[1] === "##" ? 2 : 3;
    const text = stripHeaderAnchor(match[2]);
    if (!text) continue;
    toc.push({ id: slugger.slug(text), text, depth });
  }

  return toc;
}

function buildAnchorMap(markdown: string): Map<string, string> {
  const slugger = new GithubSlugger();
  const anchorMap = new Map<string, string>();
  const headingAnchorRe =
    /^(#{1,6})\s+<a\b(?=[\s\S]*?class="header")[\s\S]*?href="#([^"]+)"[\s\S]*?>([\s\S]*?)<\/a>\s*$/gm;

  for (const match of markdown.matchAll(headingAnchorRe)) {
    const oldId = match[2];
    const text = stripHeaderAnchor(match[3]);
    if (!oldId || !text) continue;
    anchorMap.set(oldId, slugger.slug(text));
  }

  return anchorMap;
}

function extractSummary(markdown: string): string {
  const MAX_SUMMARY_LENGTH = 180;
  const blocks = markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const block of blocks) {
    if (
      block.startsWith("#") ||
      block.startsWith(">") ||
      block.startsWith("```") ||
      /^[-_*]{3,}$/.test(block) ||
      block.includes("\n|")
    ) {
      continue;
    }

    const plain = block
      .replace(/<[^>]+>/g, " ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[`*_>#-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (plain.length > 40) {
      if (plain.length <= MAX_SUMMARY_LENGTH) {
        return plain;
      }

      const sentenceClipped = plain
        .slice(0, MAX_SUMMARY_LENGTH)
        .match(/^(.+?[.!?。]|.+?다\.|.+?니다\.)\s/u)?.[1]
        ?.trim();

      if (sentenceClipped && sentenceClipped.length >= 60) {
        return sentenceClipped;
      }

      const wordClipped = plain
        .slice(0, MAX_SUMMARY_LENGTH)
        .replace(/\s+\S*$/, "")
        .trim();

      return `${wordClipped}…`;
    }
  }

  return "Claude Code Harness 문서 아카이브";
}

function normalizeHeadingAnchors(markdown: string): string {
  return markdown.replace(
    /^(#{1,6})\s+<a\b(?=[\s\S]*?class="header")[\s\S]*?>([\s\S]*?)<\/a>\s*$/gm,
    (_full, hashes: string, inner: string) => `${hashes} ${stripHeaderAnchor(inner)}`
  );
}

function splitHref(href: string): { path: string; hash: string } {
  const [pathPart, hashPart] = href.split("#", 2);
  return {
    path: pathPart,
    hash: hashPart ? `#${hashPart}` : "",
  };
}

function mapInternalHash(
  slug: string,
  hash: string,
  anchorMaps: Map<string, Map<string, string>>
): string {
  if (!hash) return "";
  const oldId = hash.slice(1);
  const docAnchors = anchorMaps.get(slug);
  const mapped = docAnchors?.get(oldId);
  if (mapped) return `#${mapped}`;

  const normalizedOldId = oldId.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const fallback = docAnchors
    ? Array.from(docAnchors.entries()).find(
        ([sourceId]) =>
          sourceId.replace(/[^a-z0-9]/gi, "").toLowerCase() === normalizedOldId
      )?.[1]
    : undefined;
  return fallback ? `#${fallback}` : "";
}

function normalizeHref(
  href: string,
  slugSet: Set<string>,
  anchorMaps: Map<string, Map<string, string>>
): string {
  if (!href || href.startsWith("#")) return href;

  const { path: hrefPath, hash } = splitHref(href);
  const absoluteMatch = hrefPath.match(
    /^https:\/\/zhanghandong\.github\.io\/harness-engineering-from-cc-to-ai-coding\/en\/(.+\.html)$/
  );

  if (absoluteMatch) {
    const slug = externalPathToSlug(absoluteMatch[1]);
    if (slugSet.has(slug)) {
      return `/read/${slug}${mapInternalHash(slug, hash, anchorMaps)}`;
    }
    return href;
  }

  if (hrefPath.startsWith("../../")) {
    const originalPath = hrefPath.replace(/^(?:\.\.\/)+/, "");
    return `${ORIGINAL_SOURCE_BASE}/${originalPath}${hash}`;
  }

  if (hrefPath === "../") {
    return `${ORIGINAL_SOURCE_BASE}/${hash ? hash.slice(1) : ""}`;
  }

  if (hrefPath.startsWith("../")) {
    const externalPath = hrefPath.replace(/^\.\.\//, "");
    const slug = externalPathToSlug(externalPath);
    if (slugSet.has(slug)) {
      return `/read/${slug}${mapInternalHash(slug, hash, anchorMaps)}`;
    }
  }

  if (/^[a-z0-9-]+-viz\.html$/i.test(hrefPath)) {
    return `${VISUALIZATION_BASE}/${hrefPath}${hash}`;
  }

  return href;
}

function normalizeLinks(
  markdown: string,
  slugSet: Set<string>,
  anchorMaps: Map<string, Map<string, string>>
): string {
  const normalizedMarkdownLinks = markdown.replace(/\]\(([^)\s]+)\)/g, (full, href: string) => {
    const normalizedHref = normalizeHref(href, slugSet, anchorMaps);
    return normalizedHref === href ? full : `](${normalizedHref})`;
  });

  return normalizedMarkdownLinks.replace(DOC_LINK_RE, (full, externalPath) => {
    const slug = externalPathToSlug(externalPath);
    if (slugSet.has(slug)) {
      return `/read/${slug}`;
    }
    return full;
  });
}

function normalizeTableWrappers(markdown: string): string {
  return markdown.replace(/<div class="table-wrapper">\s*/g, "").replace(/\s*<\/div>/g, "");
}

function normalizeMarkdown(
  markdown: string,
  slugSet: Set<string>,
  anchorMaps: Map<string, Map<string, string>>
): string {
  return normalizeLinks(
    normalizeTableWrappers(normalizeHeadingAnchors(markdown)),
    slugSet,
    anchorMaps
  );
}

export function normalizeImageSrc(src: string): string {
  if (!src) return src;
  if (LOCAL_ASSET_RE.test(src)) {
    return "https://zhanghandong.github.io/harness-engineering-from-cc-to-ai-coding/en/assets/cover-en.jpeg";
  }
  return src;
}

let cache: DocumentItem[] | null = null;

export function getAllDocuments(): DocumentItem[] {
  if (cache) return cache;

  const orderMap = parseOrderMap();
  const files = getMarkdownFiles();
  const slugSet = new Set(files.map((file) => file.replace(/\.md$/, "")));
  const anchorMaps = new Map<string, Map<string, string>>();

  files.forEach((file) => {
    const slug = file.replace(/\.md$/, "");
    const sourcePath = path.join(CONTENT_DIR, file);
    const original = fs.readFileSync(sourcePath, "utf8");
    anchorMaps.set(slug, buildAnchorMap(original));
  });

  const docs: DocumentItem[] = files
    .map((file, index) => {
      const slug = file.replace(/\.md$/, "");
      const sourcePath = path.join(CONTENT_DIR, file);
      const original = fs.readFileSync(sourcePath, "utf8");
      const normalized = normalizeMarkdown(original, slugSet, anchorMaps);
      const record = orderMap.get(slug);
      return {
        slug,
        title: record?.title ?? extractTitle(normalized),
        section: inferSection(slug),
        order: record?.order ?? 1000 + index,
        partLabel:
          record?.partLabel ?? (inferSection(slug) === "appendix" ? "부록" : null),
        sourcePath,
        markdownBody: normalized,
        toc: buildToc(normalized),
        prevSlug: null,
        nextSlug: null,
        externalSourceUrl: record?.externalUrl ?? null,
        summary: extractSummary(normalized),
      } satisfies DocumentItem;
    })
    .sort((a, b) => a.order - b.order);

  docs.forEach((doc, index) => {
    doc.prevSlug = docs[index - 1]?.slug ?? null;
    doc.nextSlug = docs[index + 1]?.slug ?? null;
  });

  cache = docs;
  return docs;
}

export function getDocumentBySlug(slug: string): DocumentItem | undefined {
  return getAllDocuments().find((doc) => doc.slug === slug);
}

export function getDocumentsBySection(section: DocSection): DocumentItem[] {
  return getAllDocuments().filter((doc) => doc.section === section);
}

export function getPartGroups(): Array<{ label: string; docs: DocumentItem[] }> {
  const groups = new Map<string, DocumentItem[]>();
  for (const doc of getAllDocuments().filter((item) => item.section === "part")) {
    const label = doc.partLabel ?? "기타";
    const list = groups.get(label) ?? [];
    list.push(doc);
    groups.set(label, list);
  }

  return Array.from(groups.entries()).map(([label, docs]) => ({ label, docs }));
}
