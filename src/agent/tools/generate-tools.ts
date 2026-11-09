import { z } from "zod";
export const generateToolSchemas = {
  submit_titles: z
    .object({
      chapterId: z.string(),
      inputHash: z.string(),
      titles: z.array(z.string()),
    })
    .strict(),
  submit_summary: z
    .object({
      chapterId: z.string(),
      inputHash: z.string(),
      summary: z.string(),
    })
    .strict(),
};
export const generateToolEntries = Object.entries(generateToolSchemas).map(
  ([name, schema]) => ({
    type: "function",
    function: {
      name,
      description:
        name === "submit_titles"
          ? "提交标题正文候选，不选择或替换标题"
          : "提交本次目标的摘要或局部要点，不写正文",
      parameters: z.toJSONSchema(schema),
    },
  }),
);
