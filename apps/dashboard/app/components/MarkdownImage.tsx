import type { Components, ExtraProps } from "streamdown";

export const MARKDOWN_IMAGE_COMPONENTS: Components = { img: MarkdownImage };

// Markdown from a model can name any host, so an image is a link and never loads unasked.
export function MarkdownImage({
  src,
  alt,
}: React.ComponentProps<"img"> & ExtraProps): React.JSX.Element | null {
  // Streamdown stands a placeholder scheme in for an image that is still streaming.
  if (typeof src !== "string" || src === "" || src.startsWith("streamdown:")) {
    return null;
  }

  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="wrap-anywhere cursor-pointer font-medium text-primary underline"
    >
      {alt || src}
    </a>
  );
}
