"use client";

/**
 * CodeMirror editor for tool source: JavaScript highlighting, bracket matching
 * and Prettier. Prettier is imported on demand so its parser never rides along
 * in the side panel's first load.
 */
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { useTheme } from "next-themes";
import { useCallback, useMemo } from "react";

const EXTENSIONS = [javascript()];

/** Prettier over the tool source. Throws on a syntax error, so callers report it. */
export async function formatSource(source: string): Promise<string> {
  const [standalone, babel, estree] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/babel"),
    import("prettier/plugins/estree"),
  ]);

  return await standalone.format(source, {
    parser: "babel",
    plugins: [babel.default, estree.default],
  });
}

export function CodeEditor({
  value,
  onChange,
  readOnly,
}: {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
}) {
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
