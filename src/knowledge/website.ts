import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { ReceptionistRepository } from "../db/repository.js";

const ALLOWED_HOSTS = new Set(["herabeauty.sg", "www.herabeauty.sg"]);
const MAX_SITEMAP_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 120;

export interface ExtractedWebPage {
  url: string;
  title: string;
  body: string;
  checksum: string;
}

export interface WebsiteSyncSummary {
  discovered: number;
  processed: number;
  approved: number;
  drafted: number;
  failed: number;
}

export function isAllowedHeraUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function fetchText(
  url: string,
  maxBytes: number,
  request: typeof fetch,
): Promise<{ text: string; finalUrl: string; contentType: string }> {
  if (!isAllowedHeraUrl(url)) throw new Error("URL is outside the Hera website allowlist");
  const response = await request(url, {
    redirect: "follow",
    headers: { "User-Agent": "HeraKnowledgeSync/1.0 (+https://www.herabeauty.sg/)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Website returned HTTP ${response.status}`);
  if (!isAllowedHeraUrl(response.url || url)) throw new Error("Website redirected off the Hera allowlist");
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Website response exceeded the maximum size");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("Website response exceeded the maximum size");
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    finalUrl: response.url || url,
    contentType: response.headers.get("content-type") || "",
  };
}

function sitemapLocations(xml: string): string[] {
  const $ = load(xml, { xmlMode: true });
  return $("loc")
    .toArray()
    .map((element) => $(element).text().trim())
    .filter(isAllowedHeraUrl);
}

export async function discoverHeraWebsiteUrls(
  sitemapUrl: string,
  request: typeof fetch = fetch,
): Promise<string[]> {
  const configured = new URL(sitemapUrl);
  const candidates = [
    configured.toString(),
    new URL("/sitemap_index.xml", configured).toString(),
    new URL("/wp-sitemap.xml", configured).toString(),
  ];
  let rootLocations: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const root = await fetchText(candidate, MAX_SITEMAP_BYTES, request);
      rootLocations = sitemapLocations(root.text);
      if (rootLocations.length > 0) break;
    } catch {
      continue;
    }
  }
  if (rootLocations.length === 0) throw new Error("No usable Hera sitemap was found");
  const nestedSitemaps = rootLocations.filter((url) => /\.xml(?:\?|$)/i.test(url)).slice(0, 20);
  const pageUrls = rootLocations.filter((url) => !/\.xml(?:\?|$)/i.test(url));

  for (const nested of nestedSitemaps) {
    const response = await fetchText(nested, MAX_SITEMAP_BYTES, request);
    pageUrls.push(
      ...sitemapLocations(response.text).filter((url) => !/\.xml(?:\?|$)/i.test(url)),
    );
  }
  return [...new Set(pageUrls)].slice(0, MAX_PAGES);
}

export function extractHeraWebPage(html: string, sourceUrl: string): ExtractedWebPage | null {
  if (!isAllowedHeraUrl(sourceUrl)) return null;
  const $ = load(html);
  const robots = $('meta[name="robots"]').attr("content")?.toLowerCase() ?? "";
  if (robots.includes("noindex")) return null;

  $("script, style, noscript, svg, iframe, form, template").remove();
  const content = $("main, article").first().length
    ? $("main, article").first().clone()
    : $("body").clone();
  content.find("br").replaceWith("\n");
  content.find("h1,h2,h3,h4,p,li,dt,dd,tr").append("\n");
  const body = content
    .text()
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line, index, lines) => index === 0 || line !== lines[index - 1])
    .join("\n")
    .slice(0, 120_000);
  if (body.length < 20) return null;

  const title =
    $("h1").first().text().replace(/\s+/g, " ").trim() ||
    $("title").text().replace(/\s+/g, " ").trim() ||
    new URL(sourceUrl).pathname;
  const checksum = createHash("sha256")
    .update(`${title}\n${body}`)
    .digest("hex");
  return { url: sourceUrl, title: title.slice(0, 500), body, checksum };
}

export async function syncHeraWebsiteKnowledge(input: {
  repository: ReceptionistRepository;
  sitemapUrl: string;
  autoApprove: boolean;
  request?: typeof fetch;
}): Promise<WebsiteSyncSummary> {
  const request = input.request ?? fetch;
  const urls = await discoverHeraWebsiteUrls(input.sitemapUrl, request);
  const summary: WebsiteSyncSummary = {
    discovered: urls.length,
    processed: 0,
    approved: 0,
    drafted: 0,
    failed: 0,
  };

  for (let offset = 0; offset < urls.length; offset += 5) {
    const batch = urls.slice(offset, offset + 5);
    await Promise.all(
      batch.map(async (url) => {
        try {
          const response = await fetchText(url, MAX_PAGE_BYTES, request);
          if (!/text\/html|application\/xhtml\+xml/i.test(response.contentType)) return;
          const page = extractHeraWebPage(response.text, response.finalUrl);
          if (!page) return;
          const version = `website-${new Date().toISOString().slice(0, 10)}-${page.checksum.slice(0, 12)}`;
          const status = await input.repository.upsertWebsiteKnowledge({
            title: page.title,
            body: page.body,
            sourceUrl: page.url,
            checksum: page.checksum,
            version,
            autoApprove: input.autoApprove,
            metadata: { ingestion: "official_sitemap", fetchedAt: new Date().toISOString() },
          });
          summary.processed += 1;
          if (status === "approved") summary.approved += 1;
          else summary.drafted += 1;
        } catch {
          summary.failed += 1;
        }
      }),
    );
  }
  return summary;
}
