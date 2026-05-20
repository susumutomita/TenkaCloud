export function pushPatternLengthNote(args: {
  lines: string[];
  patternLength: number;
  cycles: number;
  message: string;
}): void {
  const { lines, patternLength, cycles, message } = args;
  if (patternLength !== cycles) {
    lines.push(message);
  }
}
