"use client";

import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { useTheme } from "next-themes";
import { useCallback, useMemo } from "react";

export type CodeLanguage = "javascript" | "typescript" | "plain";

const EXTENSIONS = {
  javascript: [javascript()],
  typescript: [javascript({ jsx: true, typescript: true })],
  plain: [],
};

// Formatting lives in `@/app/lib/formatSource`, so importing it never pulls in CodeMirror.
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
