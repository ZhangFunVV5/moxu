import { zipSync } from "fflate";

/**
 * 测试夹具：自建最小 EPUB 2/3 容器，不依赖外部书籍与第三方样本。
 * 所有内容均为本项目自写，可随测试合法分发。
 */
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function xhtml(body: string, title = "章节"): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>${xml(title)}</title></head>
<body>${body}</body>
</html>`;
}

export interface TocItem {
  label: string;
  href: string;
}

export interface FixtureOptions {
  version?: "2" | "3";
  title?: string;
  language?: string;
  authors?: string[];
  docs: Record<string, string>;
  /** 相对 OPF 目录的容器路径，顺序即 spine 阅读顺序。 */
  spine: string[];
  /** OPF 中的 href 覆盖（用于 URL 编码测试）。 */
  hrefs?: Record<string, string>;
  nav?: TocItem[];
  ncx?: TocItem[];
  extraMeta?: string;
  encryption?: string;
  extraFiles?: Record<string, string>;
  packageDir?: string;
  omitContainer?: boolean;
  omitOpf?: boolean;
}

export function makeEpub(options: FixtureOptions): Uint8Array {
  const version = options.version ?? "3";
  const packageDir = options.packageDir ?? "OEBPS";
  const opfPath = `${packageDir}/content.opf`;
  const docKeys = Object.keys(options.docs);
  const items = docKeys
    .map(
      (key, index) =>
        `<item id="doc-${index}" href="${xml(options.hrefs?.[key] ?? key)}" media-type="application/xhtml+xml"/>`,
    )
    .join("\n");
  const navItem =
    options.nav !== undefined
      ? `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`
      : "";
  const ncxItem =
    options.ncx !== undefined
      ? `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`
      : "";
  const spineIndex = new Map(docKeys.map((key, index) => [key, index]));
  const itemrefs = options.spine
    .map((key) => {
      const index = spineIndex.get(key);
      if (index === undefined)
        throw new Error(`spine 引用不存在的文档：${key}`);
      return `<itemref idref="doc-${index}"/>`;
    })
    .join("\n");
  const creators = (options.authors ?? [])
    .map((author) => `<dc:creator>${xml(author)}</dc:creator>`)
    .join("");
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0" unique-identifier="pub-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">urn:uuid:11111111-1111-4111-8111-111111111111</dc:identifier>
<dc:title>${xml(options.title ?? "测试书")}</dc:title>
<dc:language>${xml(options.language ?? "zh-CN")}</dc:language>
${creators}
${options.extraMeta ?? ""}
</metadata>
<manifest>
${navItem}
${ncxItem}
${items}
</manifest>
<spine${options.ncx ? ' toc="ncx"' : ""}>
${itemrefs}
</spine>
</package>`;
  const nav =
    options.nav !== undefined
      ? xhtml(
          `<nav epub:type="toc" id="toc"><ol>${options.nav
            .map(
              (item) =>
                `<li><a href="${xml(item.href)}">${xml(item.label)}</a></li>`,
            )
            .join("")}</ol></nav>`,
          "目录",
        )
      : "";
  const ncx =
    options.ncx !== undefined
      ? `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:11111111-1111-4111-8111-111111111111"/></head>
<docTitle><text>${xml(options.title ?? "测试书")}</text></docTitle>
<navMap>${options.ncx
        .map(
          (item, index) =>
            `<navPoint id="n${index}" playOrder="${index + 1}"><navLabel><text>${xml(item.label)}</text></navLabel><content src="${xml(item.href)}"/></navPoint>`,
        )
        .join("")}</navMap>
</ncx>`
      : "";
  const containerXml = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="${xml(opfPath)}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const entries: Record<string, Uint8Array> = {
    mimetype: encoder.encode("application/epub+zip"),
  };
  if (!options.omitContainer)
    entries["META-INF/container.xml"] = encoder.encode(containerXml);
  if (!options.omitOpf) entries[opfPath] = encoder.encode(opf);
  for (const [key, body] of Object.entries(options.docs))
    entries[`${packageDir}/${key}`] = encoder.encode(body);
  if (options.nav !== undefined)
    entries[`${packageDir}/nav.xhtml`] = encoder.encode(nav);
  if (options.ncx !== undefined)
    entries[`${packageDir}/toc.ncx`] = encoder.encode(ncx);
  if (options.encryption)
    entries["META-INF/encryption.xml"] = encoder.encode(options.encryption);
  for (const [path, body] of Object.entries(options.extraFiles ?? {}))
    entries[path] = encoder.encode(body);
  return zipSync(entries);
}
