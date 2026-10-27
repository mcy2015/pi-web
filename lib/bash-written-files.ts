/**
 * Best-effort extraction of the files a shell command writes.
 *
 * A `bash` tool call's arguments carry only the command text, so unlike
 * `edit`/`write` there is no path field to read: the paths come from parsing
 * the command. The parser is deliberately conservative — it splits the
 * command into pipeline segments, looks at each segment's first word, and
 * counts only unambiguous file-writing forms:
 *
 *   - redirects (`>`, `>>`, `&>`, `N>`, `N>>`, and their attached forms)
 *   - `tee [-a] FILE`, `touch FILE…`, `mv SRC… DST`, `cp SRC… DST`
 *     (both with `mv -t DIR` / `cp -t DIR` targets expanded)
 *   - in-place `sed -i … FILE…`, `truncate -s N FILE…`, `dd of=FILE`
 *
 * Words are dropped when the shell, not the file, owns them: globs (`*?[`),
 * substitutions (`$(…)`, `$VAR`, backticks), options, and `/dev/*` sinks
 * (`2>/dev/null`). Deletions (`rm`) are not writes and are not listed.
 * Every path is a guess the caller resolves against the session's cwd; a
 * wrong guess costs one wrong chip, a missed form costs only a missing one.
 */

const MAX_COMMAND_LENGTH = 200_000;
const MAX_PATHS = 100;

interface Word {
  /** The word's characters with quotes removed (escapes inside kept). */
  text: string;
  /** True when the word was quoted in any part, so the shell took it literally. */
  quoted: boolean;
}

/**
 * Split a command on unquoted separators (`;`, `|`, `&`, newline), tokenize
 * each segment into words, and strip an unquoted `#` comment from its end.
 */
function splitSegments(command: string): Word[][] {
  const segments: Word[][] = [];
  let words: Word[] = [];
  let current = "";
  let quoted = false;
  let quote = "";

  const endWord = () => {
    if (current.length > 0 || quoted) words.push({ text: current, quoted });
    current = "";
    quoted = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === "\\" && quote === '"' && command[i + 1]) {
        current += command[i + 1];
        i += 1;
        continue;
      }
      if (char === quote) {
        quote = "";
        continue;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      continue;
    }
    if (char === "\\") {
      if (command[i + 1]) {
        current += command[i + 1];
        quoted = quoted || /[^\w./-]/.test(command[i + 1]);
        i += 1;
      }
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n") {
      // `|`, `&`, `||`, `&&` all separate commands; the joining word is dropped.
      if (command[i + 1] === "|" || command[i + 1] === "&") i += 1;
      endSegment();
      continue;
    }
    if (char === "#" && current.length === 0) {
      // A comment: the rest of the line is not a command.
      const newline = command.indexOf("\n", i);
      i = newline === -1 ? command.length - 1 : newline - 1;
      endSegment();
      continue;
    }
    if (/\s/.test(char)) {
      endWord();
      continue;
    }
    current += char;
  }
  endSegment();
  return segments;
}

/** Strip leading `env`/`sudo`/`nohup` and `NAME=value` assignments. */
function stripPrefixes(words: Word[]): Word[] {
  let start = 0;
  while (start < words.length) {
    const text = words[start].text;
    const base = text.slice(text.lastIndexOf("/") + 1);
    if (base === "sudo" || base === "nohup" || base === "env" || base === "command" || base === "exec") {
      start += 1;
      continue;
    }
    // An assignment before the command (FOO=bar cmd); `env` keeps its own.
    if (/^[\w]+=/.test(text) && start + 1 < words.length) {
      start += 1;
      continue;
    }
    break;
  }
  return words.slice(start);
}

/** A word the shell would expand or that names no file we can point to. */
function isOpaquePath(text: string): boolean {
  if (text.length === 0) return true;
  if (/[\$`]/.test(text)) return true; // $VAR, $(…), `…`
  if (/[*?\[]/.test(text)) return true; // globs
  if (text.startsWith("-")) return true; // option
  if (text.startsWith("~")) return true; // home expansion is not ours to do
  if (text.startsWith("/dev/")) return true; // 2>/dev/null sinks
  return false;
}

interface OptionSpec {
  /** Short options that consume the next word (`sed -e SCRIPT`, `mv -t DIR`). */
  shortWithArg?: ReadonlySet<string>;
  /** Long options that consume the next word. */
  longWithArg?: ReadonlySet<string>;
  /** Flags that mean the operands are edited in place (`sed -i`). */
  inPlace?: ReadonlySet<string>;
  /** True when `-t DIR`/`--target-directory DIR` names the destination dir. */
  targetDir?: boolean;
  /** True when an option can carry the script operand (`sed -e/-f`). */
  expression?: boolean;
}

interface OperandPlan {
  /** Operands (non-option words) in order. */
  operands: string[];
  /** `-t DIR`-style target directory, when the command takes one. */
  targetDirectory?: string;
  /** True when the command edits its operand files in place. */
  inPlace: boolean;
  /** True when a `-e`/`-f`-style option supplied what would be operand 0. */
  expressionSeen: boolean;
}

/** Walk a command's words past its options and collect its operands. */
function planOperands(words: Word[], spec: OptionSpec): OperandPlan {
  const shortWithArg = spec.shortWithArg ?? new Set<string>();
  const longWithArg = spec.longWithArg ?? new Set<string>();
  const inPlaceFlags = spec.inPlace ?? new Set<string>();
  const operands: string[] = [];
  let targetDirectory: string | undefined;
  let inPlace = false;
  let expressionSeen = false;

  const takeTarget = (value: string) => {
    if (spec.targetDir) targetDirectory = value;
  };

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const text = word.text;

    if (!word.quoted && text === "--") {
      for (let rest = i + 1; rest < words.length; rest++) operands.push(words[rest].text);
      break;
    }
    if (!word.quoted && text.startsWith("--")) {
      const eq = text.indexOf("=");
      if (eq !== -1) {
        const name = text.slice(0, eq);
        if (inPlaceFlags.has(name)) inPlace = true;
        else if (spec.expression && (name === "--expression" || name === "--file")) expressionSeen = true;
        else if (name === "--target-directory" && spec.targetDir) targetDirectory = text.slice(eq + 1);
        // Any other attached value (--date=…, --size=…) is not an operand.
        continue;
      }
      if (inPlaceFlags.has(text)) {
        inPlace = true;
        continue;
      }
      if (spec.expression && (text === "--expression" || text === "--file")) expressionSeen = true;
      if (longWithArg.has(text) && i + 1 < words.length) {
        if (text === "--target-directory") takeTarget(words[i + 1].text);
        i += 1;
        continue;
      }
      continue;
    }
    if (!word.quoted && text.startsWith("-") && text.length > 1 && !/^\d/.test(text.slice(1))) {
      const letters = text.slice(1);
      let consumed = false;
      for (let idx = 0; idx < letters.length; idx++) {
        const flag = `-${letters[idx]}`;
        if (inPlaceFlags.has(flag)) inPlace = true;
        if (spec.expression && (flag === "-e" || flag === "-f")) expressionSeen = true;
        if (shortWithArg.has(flag)) {
          const attached = letters.slice(idx + 1);
          if (attached.length > 0) {
            if (flag === "-t") takeTarget(attached);
          } else if (i + 1 < words.length) {
            if (flag === "-t") takeTarget(words[i + 1].text);
            i += 1;
          }
          consumed = true;
          break;
        }
      }
      // A cluster whose tail matched no known flag (`-i.bak`) is still an
      // option cluster: the tail is the flag's attached value, never a file.
      if (!consumed) continue;
      continue;
    }
    operands.push(text);
  }
  return { operands, targetDirectory, inPlace, expressionSeen };
}

/** Expand `mv`/`cp` operands into their destination paths. */
function moveTargets(plan: OperandPlan): string[] {
  if (plan.targetDirectory) {
    return plan.operands.map((source) => {
      const base = source.slice(source.lastIndexOf("/") + 1) || source;
      return `${plan.targetDirectory!.replace(/\/+$/, "")}/${base}`;
    });
  }
  if (plan.operands.length < 2) return [];
  const target = plan.operands[plan.operands.length - 1];
  // A trailing slash says the target is a directory: the move lands inside it.
  if (target.endsWith("/")) {
    return plan.operands.slice(0, -1).map((source) => {
      const base = source.slice(source.lastIndexOf("/") + 1) || source;
      return `${target.replace(/\/+$/, "")}/${base}`;
    });
  }
  return [target];
}

/** Extract the paths one command segment writes, or null when it writes none. */
function segmentWrittenPaths(words: Word[]): string[] | null {
  const stripped = stripPrefixes(words);
  if (stripped.length === 0) return null;
  const head = stripped[0].text;
  const command = head.slice(head.lastIndexOf("/") + 1);

  const redirectTargets: string[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const word = stripped[i];
    if (word.quoted) continue;
    // `<<` is a heredoc (its word is a delimiter, not a file); `<>` is exotic.
    if (word.text === ">" || word.text === ">>" || word.text === "&>" || word.text === "&>>") {
      const next = stripped[i + 1];
      if (next && !next.text.startsWith("&")) redirectTargets.push(next.text);
      i += 1;
      continue;
    }
    const match = word.text.match(/^(?:\d*>>|\d*>|&>>|&>|>&)(.+)$/);
    if (match) {
      const target = match[1];
      if (!target.startsWith("&")) redirectTargets.push(target);
      continue;
    }
  }

  let commandPaths: string[] = [];
  switch (command) {
    case "tee": {
      // tee's flags (-a, -i, --append, --ignore-interrupts) take no arguments.
      const plan = planOperands(stripped, {});
      commandPaths = plan.operands;
      break;
    }
    case "touch": {
      const plan = planOperands(stripped, {
        shortWithArg: new Set(["-d", "-t", "-r"]),
        longWithArg: new Set(["--date", "--reference", "--time"]),
      });
      commandPaths = plan.operands;
      break;
    }
    case "mv":
    case "cp": {
      const plan = planOperands(stripped, {
        shortWithArg: new Set(["-t", "-S", "-Z"]),
        longWithArg: new Set(["--target-directory", "--suffix", "--context"]),
        targetDir: true,
      });
      commandPaths = moveTargets(plan);
      break;
    }
    case "sed": {
      const plan = planOperands(stripped, {
        shortWithArg: new Set(["-e", "-f"]),
        longWithArg: new Set(["--expression", "--file"]),
        inPlace: new Set(["-i", "--in-place"]),
        expression: true,
      });
      // Without -i sed writes stdout only; the script is an option when -e/-f
      // supplied it, else operand 0.
      if (plan.inPlace) commandPaths = plan.expressionSeen ? plan.operands : plan.operands.slice(1);
      break;
    }
    case "truncate": {
      const plan = planOperands(stripped, {
        shortWithArg: new Set(["-s", "-r"]),
        longWithArg: new Set(["--size", "--reference"]),
      });
      commandPaths = plan.operands;
      break;
    }
    case "dd": {
      commandPaths = stripped.slice(1).flatMap((word) => {
        const match = word.text.match(/^of=(.+)$/);
        return match ? [match[1]] : [];
      });
      break;
    }
    default:
      break;
  }

  const paths = [...redirectTargets, ...commandPaths].filter((path) => !isOpaquePath(path));
  return paths.length > 0 ? paths : null;
}

/** The files a shell command text writes, in first-seen order, unresolved. */
export function extractBashWrittenPaths(command: string): string[] {
  if (typeof command !== "string" || command.length === 0 || command.length > MAX_COMMAND_LENGTH) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const segment of splitSegments(command)) {
    const written = segmentWrittenPaths(segment);
    if (!written) continue;
    for (const path of written) {
      if (seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
      if (paths.length >= MAX_PATHS) return paths;
    }
  }
  return paths;
}
