"use client";

/**
 * CodeMirror editor for tool source and read-only file previews: JavaScript
 * and TypeScript highlighting and bracket matching. Formatting lives in
 * `@/app/lib/formatSource` so importing it does not drag CodeMirror in.
 */
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { useTheme } from "next-themes";
import { useCallback, useMemo } from "react";

/** `plain` shows text with no highlighting. */
export type CodeLanguage = "javascript" | "typescript" | "plain";

const EXTENSIONS = {
  javascript: [javascript()],
  typescript: [javascript({ jsx: true, typescript: true })],
  plain: [],
};

export function CodeEditor({
  value,
  onChange,
  readOnly,
  language = "javascript",
  height = "360px",
}: {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  language?: CodeLanguage;
  /** A CSS height; "100%" fills a parent that has one. */
  height?: string;
}): React.JSX.Element {
  const { resolvedTheme } = useTheme();
  const handleChange = useCallback(
    (next: string) => {
      onChange(next);
    },
    [onChange],
  );
  const basicSetup = useMemo(
    () => ({
      lineNumbers: true,
      foldGutter: false,
      highlightActiveLine: !readOnly,
      highlightActiveLineGutter: !readOnly,
      autocompletion: !readOnly,
    }),
    [readOnly],
  );

  return (
    <div className="h-full overflow-hidden rounded-md border border-input">
      <CodeMirror
        value={value}
        onChange={handleChange}
        readOnly={readOnly}
        editable={!readOnly}
        theme={resolvedTheme === "dark" ? oneDark : "light"}
        extensions={EXTENSIONS[language]}
        basicSetup={basicSetup}
        height={height}
      />
    </div>
  );
}
