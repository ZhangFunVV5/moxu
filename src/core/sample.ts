export const chapters = [
  {
    id: "c1",
    title: "雨夜归人",
    body: "雨落在青石板上，像细密的鼓点。\n\n沈舟站在旧宅门前，抬头看了一眼檐下的灯。那灯还亮着，温暖的光穿过薄薄的雨雾。\n\n“你终于回来了。”门里传来一个熟悉的声音。\n\n他没有立刻回答，只把手中的旧信攥得更紧。十年过去，这座小城似乎什么都没有改变。",
  },
  {
    id: "c2",
    title: "旧信",
    body: "清晨，雨停了。\n\n桌上的信封已经泛黄，封口却仍旧完好。",
  },
  { id: "c3", title: "渡口", body: "河面升起薄雾，小船在渡口静静等候。" },
] as const;
export function readChapter(id: string) {
  return chapters.find((c) => c.id === id);
}
