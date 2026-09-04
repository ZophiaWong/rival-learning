export function normalizeQuestionV1(question: string): string {
  return question
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[?？.!。！]+$/gu, "")
    .trimEnd();
}
