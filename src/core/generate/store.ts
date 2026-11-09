import { validateTitle, validateTitles, validateText } from "./validate";
import {
  titleOptionsSchema,
  summaryOptionsSchema,
  type TitleOptions,
} from "../../shared/generate";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  generateArtifactSchema,
  type GenerateArtifact,
  GenerateError,
} from "../../shared/generate";
import { writeFileAtomic } from "../workspace/atomic-file";
export function validateArtifact(raw: unknown): GenerateArtifact {
  try {
    const a = generateArtifactSchema.parse(raw);
    if (a.kind === "title") {
      titleOptionsSchema.parse(a.options);
      if (!a.titles || a.summary !== undefined) throw Error("标题结构不匹配");
      validateTitles(a.titles, a.options as TitleOptions);
    } else {
      summaryOptionsSchema.parse(a.options);
      if (a.summary === undefined || a.titles !== undefined)
        throw Error("摘要结构不匹配");
      validateText(a.summary, a.options);
    }
    return a;
  } catch (error) {
    throw new GenerateError(
      "INVALID_ARTIFACT",
      error instanceof Error ? error.message : "产物非法",
    );
  }
}
export async function saveArtifact(root: string, artifact: GenerateArtifact) {
  const valid = validateArtifact(artifact);
  await writeFileAtomic(
    path.join(root, "generated", `${valid.artifactId}.json`),
    JSON.stringify(valid, null, 2),
  );
}
export async function listArtifacts(
  root: string,
  chapterId: string,
): Promise<GenerateArtifact[]> {
  const names = await fs.readdir(path.join(root, "generated")).catch(() => []);
  const all: GenerateArtifact[] = [];
  for (const name of names.filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))) {
    let valid: GenerateArtifact;
    try {
      valid = validateArtifact(
        JSON.parse(
          await fs.readFile(path.join(root, "generated", name), "utf8"),
        ),
      );
    } catch (error) {
      throw new GenerateError("INVALID_ARTIFACT", "生成产物文件损坏");
    }
    if (valid.chapterId === chapterId) all.push(valid);
  }
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
