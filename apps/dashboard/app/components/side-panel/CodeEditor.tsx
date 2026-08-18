"use client";

/**
 * CodeMirror editor for tool source: JavaScript highlighting and bracket
 * matching. Formatting lives in `@/app/lib/formatSource` so importing it does
 * not drag CodeMirror in.
 */
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { useTheme } from "next-themes";
import { useCallback, useMemo } from "react";

const EXTENSIONS = [javascript()];

export function CodeEditor({
  value,
  onChange,
  readOnly,
}: {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
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
      autocompletion: true,
    }),
    [readOnly],
  );

  return (
    <div className="overflow-hidden rounded-md border border-input">
      <CodeMirror
        value={value}
        onChange={handleChange}
        readOnly={readOnly}
        theme={resolvedTheme === "dark" ? oneDark : "light"}
        extensions={EXTENSIONS}
        basicSetup={basicSetup}
        height="360px"
      />
    </div>
  );
}
